import { createHash, timingSafeEqual } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
    CallToolRequest,
    CallToolResult,
    ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { buildWake } from "./channel-message.js";
import { sanitizeName } from "./identity.js";
import type { Inbox } from "./inbox.js";
import type { PingLog } from "./ping-log.js";
import type { PresenceRegistry } from "./presence.js";
import type { ChannelPush } from "./push.js";

/** Max `send` content length — a key-holder otherwise stores/injects unbounded
 * text into a peer's RAM and context. */
export const MAX_CONTENT = 16 * 1024;

/** A live MCP session: its SDK server (the wake handle), its transport (the
 * session id source), and the name it came online as (if any). */
export interface Session {
    server: Server;
    transport: StreamableHTTPServerTransport;
    voiceName?: string;
}

/** The collaborators the tool dispatch needs — injected so it stays testable
 * without booting an http server. */
export interface ToolDeps {
    presence: PresenceRegistry;
    push: ChannelPush;
    pingLog: PingLog;
    inbox: Inbox;
}

// ─── tools ──────────────────────────────────────────────────────────────────
export const TOOLS: ListToolsResult = {
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

export function ok(payload: unknown): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export function toolError(code: string, message: string): CallToolResult {
    return {
        content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
        isError: true,
    };
}

/**
 * Validate a provided X-Api-Key against the expected one in constant time.
 *
 * Both sides are SHA-256'd to a fixed 32 bytes before comparing, so the
 * comparison is constant-time with respect to length too (a raw length check
 * would leak the key length via early return). A missing key is rejected before
 * hashing.
 */
export function isApiKeyValid(provided: string | undefined, expected: string): boolean {
    if (!provided) return false;
    const providedDigest = createHash("sha256").update(provided).digest();
    const expectedDigest = createHash("sha256").update(expected).digest();
    return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Build the CallTool dispatcher bound to a set of collaborators. The returned
 * `callTool(request, session)` carries NO boot side-effects, so it is importable
 * and testable on its own.
 */
export function createCallTool(deps: ToolDeps) {
    const { presence, push, pingLog, inbox } = deps;

    return async function callTool(
        request: CallToolRequest,
        session: Session,
    ): Promise<CallToolResult> {
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
                return toolError(
                    "invalid_arguments",
                    "send: `to` and `content` are required strings.",
                );
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
    };
}
