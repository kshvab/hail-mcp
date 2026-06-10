#!/usr/bin/env node
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { createCallTool, isApiKeyValid, TOOLS } from "./handlers.js";
import type { Session } from "./handlers.js";
import { extractVoiceName } from "./identity.js";
import { log } from "./log.js";
import { PresenceRegistry } from "./presence.js";
import { ChannelPush } from "./push.js";
import { PingLog } from "./ping-log.js";
import { Inbox } from "./inbox.js";
import { InMemoryEventStore } from "./event-store.js";

const API_KEY_HEADER = "x-api-key";
const SERVER_NAME = "hail";
// MAX_CONTENT, the TOOLS list, ok()/toolError(), the tool dispatch, the Session
// type, and the constant-time key check live in handlers.ts — they're the
// importable, side-effect-free surface this boot file wires to live instances.
// Track package.json so the version advertised over the MCP initialize handshake
// can't drift. dist/server.js and package.json both ship in the npm package.
const SERVER_VERSION = (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        version: string;
    }
).version;

/**
 * SSE keepalive interval. The GET SSE stream is idle-closed by Claude Code's
 * channel client if it goes quiet, which makes CC re-initialize a whole new
 * session (cycling) and a push then lands on a dead one. A periodic comment
 * keeps the stream — and the session — alive.
 */
const KEEPALIVE_MS = 15_000;

/** Cap on concurrent live MCP sessions — bounds the sessions map (and the
 * per-session event buffers) against a key-holder opening streams without
 * limit. */
const MAX_SESSIONS = 2000;

const INSTRUCTIONS =
    "hail — a SYMMETRIC peer-messaging bridge for Claude Code voices. " +
    "Every participant is a connected, wakeable peer. " +
    "register() binds your X-Voice-Name header to this live session so others can reach you. " +
    "who_is_online() lists the peers you can reach right now. " +
    "send({ to, content }) wakes that peer with your message. " +
    'Inbound messages arrive as a channel turn tagged <channel source="hail" ...>; ' +
    "to reply, simply send() back to the sender.";

// ─── wiring (plain instances, no framework) ─────────────────────────────────
const config = loadConfig();
const presence = new PresenceRegistry();
const push = new ChannelPush(presence);
const pingLog = new PingLog();
const inbox = new Inbox();
const sessions = new Map<string, Session>();
// The tool dispatcher, bound once to the live collaborators above.
const callTool = createCallTool({ presence, push, pingLog, inbox });

// ─── session lifecycle (the proven harness pattern) ─────────────────────────
function createSession(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const voiceName = extractVoiceName(req);

    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        {
            capabilities: { tools: {}, experimental: { "claude/channel": {} } },
            instructions: INSTRUCTIONS,
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => TOOLS);
    server.setRequestHandler(CallToolRequestSchema, (request: CallToolRequest) =>
        callTool(request, session),
    );

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // Per-session EventStore: replays server pushes to the standalone GET
        // stream on reconnect (Last-Event-ID). A per-session instance avoids
        // cross-session stream-id mixing a single shared store would cause.
        eventStore: new InMemoryEventStore(),
        onsessioninitialized: (id: string) => {
            sessions.set(id, session);
            // Bind presence ON CONNECT (from the X-Voice-Name header), not on a
            // register tool call — Claude Code re-initializes the whole session
            // when its GET stream cycles, and the new session never re-calls
            // register. Binding here (takeover) keeps presence pointed at the
            // voice's CURRENT live session so a push never targets a dead one.
            if (voiceName) {
                presence.register(voiceName, server, id);
            }
            log.info(`session initialized: ${id} (voice=${voiceName ?? "?"})`);
        },
    });

    const session: Session = { server, transport, voiceName };

    transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
            presence.removeBySession(sid);
            sessions.delete(sid);
            log.info(`session closed: ${sid}`);
        }
    };

    return server.connect(transport).then(() => transport.handleRequest(req, res, body));
}

function sessionIdHeader(req: IncomingMessage): string | undefined {
    const raw = req.headers["mcp-session-id"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value && value.trim() ? value : undefined;
}

function badRequest(res: ServerResponse, message: string): void {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function handlePost(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sid = sessionIdHeader(req);
    if (sid) {
        const session = sessions.get(sid);
        if (!session) return badRequest(res, "unknown or expired mcp-session-id");
        await session.transport.handleRequest(req, res, body);
        return;
    }
    if (!isInitializeRequest(body)) {
        return badRequest(res, "no mcp-session-id and not an initialize request");
    }
    if (sessions.size >= MAX_SESSIONS) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
            JSON.stringify({ error: { code: "server_busy", message: "session capacity reached" } }),
        );
        return;
    }
    await createSession(req, res, body);
}

async function routeBySession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sid = sessionIdHeader(req);
    const session = sid ? sessions.get(sid) : undefined;
    if (!session) return badRequest(res, "unknown or missing mcp-session-id");
    await session.transport.handleRequest(req, res);
}

// ─── shared-key gate (constant-time) ────────────────────────────────────────
// isApiKeyValid (handlers.ts) SHA-256s both sides to a fixed 32 bytes before
// comparing, so the comparison is constant-time with respect to length too.
function authorized(req: IncomingMessage): boolean {
    const raw = req.headers[API_KEY_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    return isApiKeyValid(provided, config.apiKey);
}

// ─── raw http server (harness framing — the part that wakes Claude Code) ─────
const httpServer = http.createServer((req, res) => {
    void (async () => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.port}`);
        if (url.pathname !== "/mcp") {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "not found" }));
            return;
        }
        if (!authorized(req)) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    error: { code: "api_key_invalid", message: "Invalid or missing X-Api-Key" },
                }),
            );
            return;
        }

        const sid = (req.headers["mcp-session-id"] as string | undefined) ?? "-";
        const accept = req.headers["accept"] ?? "-";

        if (req.method === "POST") {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            let body: unknown;
            try {
                body = chunks.length
                    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
                    : undefined;
            } catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "invalid json body" }));
                return;
            }
            const method = (body as { method?: string } | undefined)?.method;
            log.debug(`POST(${method ?? "?"}) sid=${sid} accept="${accept}"`);
            await handlePost(req, res, body);
            return;
        }
        if (req.method === "GET") {
            log.debug(`GET sid=${sid} accept="${accept}"`);
            // SSE keepalive (see KEEPALIVE_MS): a `:`-comment is valid SSE the
            // client ignores, safely interleaved between the SDK's data events.
            const keepalive = setInterval(() => {
                // Only write once the SDK has sent the SSE headers — writing
                // first would auto-flush a 200 and make the SDK's writeHead throw.
                if (res.headersSent && !res.writableEnded) res.write(": keepalive\n\n");
            }, KEEPALIVE_MS);
            // The GET SSE stream IS the wake channel. When it drops, this session
            // can no longer be woken — so evict its presence the instant the stream
            // ends, keyed by session id (a newer session that already took the name
            // over is left untouched, since removeBySession only matches this sid).
            // transport.onclose does NOT fire on a bare GET-stream death, so without
            // this the registry keeps a dead wake handle: sends to the name push
            // into a closed stream, server.notification doesn't throw, the message
            // is reported delivered and silently lost. Evicting here makes those
            // sends miss and fall through to the inbox (get_recent) instead.
            const evict = (reason: string): void => {
                clearInterval(keepalive);
                if (sid !== "-") presence.removeBySession(sid);
                log.debug(`GET stream ${reason} (sid=${sid}) — wake presence evicted`);
            };
            res.on("close", () => evict("closed"));
            res.on("error", (err: Error) => {
                log.warn(`GET stream error (sid=${sid}): ${err.message}`);
                evict("errored");
            });
            await routeBySession(req, res);
            return;
        }
        if (req.method === "DELETE") {
            log.debug(`DELETE sid=${sid}`);
            await routeBySession(req, res);
            return;
        }
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed" }));
    })().catch((err) => {
        log.error("request error", err);
        if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "internal error" }));
        }
    });
});

httpServer.listen(config.port, () => {
    log.info(`MCP server (raw http + raw SDK) on http://localhost:${config.port}/mcp`);
});

const shutdown = (): void => {
    // Stop accepting connections, then exit once existing ones drain; a short
    // timeout forces exit if a held-open SSE stream won't close on its own.
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
