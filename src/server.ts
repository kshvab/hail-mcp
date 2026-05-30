#!/usr/bin/env node
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type {
    CallToolRequest,
    CallToolResult,
    ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { buildWake } from "./channel-message.js";
import { loadConfig } from "./config.js";
import { extractVoiceName, sanitizeName } from "./identity.js";
import { log } from "./log.js";
import { PresenceRegistry } from "./presence.js";
import { ChannelPush } from "./push.js";
import { PingLog } from "./ping-log.js";
import { Inbox } from "./inbox.js";
import { InMemoryEventStore } from "./event-store.js";

const API_KEY_HEADER = "x-api-key";
const SERVER_NAME = "hail";
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

/** Max `send` content length — a key-holder otherwise stores/injects unbounded
 * text into a peer's RAM and context. */
const MAX_CONTENT = 16 * 1024;

const INSTRUCTIONS =
    "hail — a SYMMETRIC peer-messaging bridge for Claude Code voices. " +
    "Every participant is a connected, wakeable peer. " +
    "register() binds your X-Voice-Name header to this live session so others can reach you. " +
    "who_is_online() lists the peers you can reach right now. " +
    "send({ to, content }) wakes that peer with your message. " +
    'Inbound messages arrive as a channel turn tagged <channel source="hail" ...>; ' +
    "to reply, simply send() back to the sender.";

interface Session {
    server: Server;
    transport: StreamableHTTPServerTransport;
    voiceName?: string;
}

// ─── wiring (plain instances, no framework) ─────────────────────────────────
const config = loadConfig();
const presence = new PresenceRegistry();
const push = new ChannelPush(presence);
const pingLog = new PingLog();
const inbox = new Inbox();
const sessions = new Map<string, Session>();

// ─── tools ──────────────────────────────────────────────────────────────────
const TOOLS: ListToolsResult = {
    tools: [
        {
            name: "register",
            description:
                "Come online as a named peer so others can reach you with send(). A session that connected WITH a name (via the ?name= URL / X-Voice-Name header) is already online and need not call this. A session that connected WITHOUT a name (e.g. a cold instance with no env var set) can pass `name` here to come online. If the name was already online (a prior session that dropped), this takes it over.",
            inputSchema: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description:
                            "Optional. The name to come online as — required only if this session connected without one. Defaults to the connection's name.",
                    },
                },
            },
            annotations: { readOnlyHint: false, openWorldHint: false },
        },
        {
            name: "who_is_online",
            description:
                "List the peers currently online and reachable. Returns their names. Use a name as the `to` of send().",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        {
            name: "send",
            description:
                "Send a message to an online peer by name. The peer's idle session wakes immediately and receives your message tagged with your name. To reply, the peer simply sends back to you.",
            inputSchema: {
                type: "object",
                properties: {
                    to: {
                        type: "string",
                        description: "The target peer's name (see who_is_online).",
                    },
                    content: { type: "string", description: "The message to deliver." },
                },
                required: ["to", "content"],
            },
            annotations: { readOnlyHint: false, openWorldHint: true },
        },
        {
            name: "get_recent",
            description:
                "Return the most recent messages sent TO you (your inbox), newest last, each with its sender name and time. This is the pull path: if your session can't be woken by a push (e.g. a cloud instance), others send to your name while you're away and you poll here. A wakeable session receives sends live and rarely needs this. Requires that you have a name.",
            inputSchema: {
                type: "object",
                properties: {
                    n: {
                        type: "number",
                        description: "How many recent messages to return (default 10, max 50).",
                    },
                },
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
    ],
};

function ok(payload: unknown): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function toolError(code: string, message: string): CallToolResult {
    return {
        content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
        isError: true,
    };
}

async function callTool(request: CallToolRequest, session: Session): Promise<CallToolResult> {
    const { name, arguments: args } = request.params;

    if (name === "register") {
        // Name precedence: an explicit `name` argument (lets a session that
        // connected WITHOUT a name come online), else the connection's name.
        // Both go through the same validation (length / charset / no placeholder).
        const fromArg = sanitizeName(typeof args?.name === "string" ? args.name : undefined);
        const peer = fromArg ?? session.voiceName;
        if (!peer) {
            return toolError(
                "missing_voice_name",
                "register: no usable name. Pass a valid one — register({ name: 'alice' }) — or " +
                    "relaunch with a name set (HAIL_NAME -> the ?name= URL, or an X-Voice-Name " +
                    "header), in which case you come online automatically and need not call " +
                    "register. Names allow letters, digits, '.', '_', '-', up to 64 chars. " +
                    "You can still send() without a name.",
            );
        }
        const sessionId = session.transport.sessionId;
        if (!sessionId) {
            return toolError("no_session", "register: no MCP session id on the transport.");
        }
        const result = presence.register(peer, session.server, sessionId);
        if (!result) {
            return toolError(
                "presence_full",
                "register: the bridge is at peer capacity right now — try again shortly.",
            );
        }
        // Adopt the name for this session so later send()s show the right `from`.
        session.voiceName = peer;
        return ok({ ok: true, name: peer, already_online: result.tookOver });
    }

    if (name === "who_is_online") {
        return ok({ voices: presence.list() });
    }

    if (name === "send") {
        const to = typeof args?.to === "string" ? args.to : undefined;
        const content = typeof args?.content === "string" ? args.content : undefined;
        if (!to || content === undefined) {
            return toolError("invalid_arguments", "send: `to` and `content` are required strings.");
        }
        if (content.length > MAX_CONTENT) {
            return toolError(
                "content_too_large",
                `send: content exceeds the ${MAX_CONTENT}-character limit.`,
            );
        }
        const cleanTo = sanitizeName(to);
        if (!cleanTo) {
            return toolError("invalid_name", "send: `to` is not a valid peer name.");
        }
        const from = session.voiceName ?? "anonymous";
        // buildWake owns the load-bearing fakechat-shaped meta (see its doc).
        const { wrapped, meta } = buildWake(from, content);
        const delivered = await push.push(cleanTo, wrapped, meta);
        // Inbox only on a MISS: a live-woken peer already has the message, so
        // get_recent never surfaces a duplicate; an offline/cloud peer pulls it
        // later. queued reflects exactly that.
        if (!delivered) inbox.add(cleanTo, from, content);
        pingLog.log(from, cleanTo, content);
        return ok({ ok: true, delivered, queued: !delivered });
    }

    if (name === "get_recent") {
        const caller = session.voiceName;
        if (!caller) {
            return toolError(
                "missing_voice_name",
                "get_recent: this session has no name, so it has no inbox. Provide a name " +
                    "(?name= URL / X-Voice-Name header, or register({ name })) to receive messages.",
            );
        }
        const rawN =
            typeof args?.n === "number" && Number.isFinite(args.n) ? Math.floor(args.n) : 10;
        const n = Math.max(1, Math.min(50, rawN));
        const messages = inbox.recent(caller, n).map((m) => ({
            from: m.from,
            content: m.content,
            at: m.at.toISOString(),
        }));
        return ok({ messages });
    }

    return toolError("internal_error", `unknown tool: ${name}`);
}

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
    await createSession(req, res, body);
}

async function routeBySession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sid = sessionIdHeader(req);
    const session = sid ? sessions.get(sid) : undefined;
    if (!session) return badRequest(res, "unknown or missing mcp-session-id");
    await session.transport.handleRequest(req, res);
}

// ─── shared-key gate (constant-time) ────────────────────────────────────────
// SHA-256 both sides to a fixed 32 bytes before comparing, so the comparison is
// constant-time with respect to length too (a raw length check would leak the
// key length via early return).
const expectedKeyDigest = createHash("sha256").update(config.apiKey).digest();

function authorized(req: IncomingMessage): boolean {
    const raw = req.headers[API_KEY_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided) return false;
    const providedDigest = createHash("sha256").update(provided).digest();
    return timingSafeEqual(providedDigest, expectedKeyDigest);
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
            res.on("close", () => {
                clearInterval(keepalive);
                log.debug(`GET stream closed (sid=${sid})`);
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
