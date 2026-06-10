import { jest } from "@jest/globals";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createCallTool, isApiKeyValid, MAX_CONTENT } from "./handlers.js";
import type { Session, ToolDeps } from "./handlers.js";
import { Inbox } from "./inbox.js";
import { PingLog } from "./ping-log.js";
import { PresenceRegistry } from "./presence.js";
import { ChannelPush } from "./push.js";

// ─── helpers ────────────────────────────────────────────────────────────────

/** A fake live session: stub `server.notification` (the wake handle) and a
 * fixed transport.sessionId, plus an optional connection name. */
function fakeSession(opts: { voiceName?: string; sessionId?: string } = {}): Session {
    const server = { notification: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) };
    const transport = { sessionId: opts.sessionId ?? "sess-1" };
    return {
        server: server as unknown as Server,
        transport: transport as unknown as StreamableHTTPServerTransport,
        voiceName: opts.voiceName,
    };
}

function req(name: string, args?: Record<string, unknown>): CallToolRequest {
    return {
        method: "tools/call",
        params: { name, arguments: args },
    } as CallToolRequest;
}

/** Parse the single JSON text payload off a CallToolResult. */
function payload(result: CallToolResult): Record<string, unknown> {
    const first = result.content[0];
    expect(first?.type).toBe("text");
    return JSON.parse((first as { text: string }).text) as Record<string, unknown>;
}

function makeDeps(): ToolDeps {
    const presence = new PresenceRegistry();
    return {
        presence,
        push: new ChannelPush(presence),
        pingLog: new PingLog(),
        inbox: new Inbox(),
    };
}

describe("callTool — register", () => {
    it("uses the connection name when no arg is given", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        const session = fakeSession({ voiceName: "Alice" });

        const res = await callTool(req("register"), session);

        expect(payload(res)).toEqual({ ok: true, name: "Alice", already_online: false });
        expect(deps.presence.has("Alice")).toBe(true);
    });

    it("prefers an explicit name arg over the connection name", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        const session = fakeSession({ voiceName: "Alice" });

        const res = await callTool(req("register", { name: "Bob" }), session);

        expect(payload(res)).toEqual({ ok: true, name: "Bob", already_online: false });
        expect(session.voiceName).toBe("Bob");
        expect(deps.presence.has("Bob")).toBe(true);
    });

    it("reports already_online=true on a takeover re-register", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);

        await callTool(req("register"), fakeSession({ voiceName: "Alice", sessionId: "s1" }));
        const res = await callTool(
            req("register"),
            fakeSession({ voiceName: "Alice", sessionId: "s2" }),
        );

        expect(payload(res)).toEqual({ ok: true, name: "Alice", already_online: true });
    });

    it("errors missing_voice_name when no name is available", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);

        const res = await callTool(req("register"), fakeSession());

        expect(res.isError).toBe(true);
        expect((payload(res).error as { code: string }).code).toBe("missing_voice_name");
    });

    it("errors missing_voice_name when the arg name is invalid/placeholder", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);

        const bad = await callTool(req("register", { name: "a b" }), fakeSession());
        expect((payload(bad).error as { code: string }).code).toBe("missing_voice_name");

        const placeholder = await callTool(
            req("register", { name: "${HAIL_NAME}" }),
            fakeSession(),
        );
        expect((payload(placeholder).error as { code: string }).code).toBe("missing_voice_name");
    });

    it("errors presence_full when the registry is at capacity for a new name", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        // Fill the registry past MAX_PEERS (1000) to force a null register.
        for (let i = 0; i < 1000; i++) {
            deps.presence.register(`peer${i}`, fakeSession().server, `sid${i}`);
        }

        const res = await callTool(req("register"), fakeSession({ voiceName: "Newcomer" }));

        expect(res.isError).toBe(true);
        expect((payload(res).error as { code: string }).code).toBe("presence_full");
    });
});

describe("callTool — send", () => {
    it("delivers to an online peer and does NOT queue to the inbox", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        // Bring the target online so the push lands.
        await callTool(req("register"), fakeSession({ voiceName: "Bob", sessionId: "bob-s" }));

        const sender = fakeSession({ voiceName: "Alice" });
        const res = await callTool(req("send", { to: "Bob", content: "hi" }), sender);

        expect(payload(res)).toEqual({ ok: true, delivered: true, queued: false });
        // A delivered send must not duplicate into the inbox.
        expect(deps.inbox.recent("Bob", 10)).toEqual([]);
    });

    it("queues to the inbox when the target is offline (delivered=false)", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        const sender = fakeSession({ voiceName: "Alice" });

        const res = await callTool(req("send", { to: "Ghost", content: "hello" }), sender);

        expect(payload(res)).toEqual({ ok: true, delivered: false, queued: true });
        const inbox = deps.inbox.recent("Ghost", 10);
        expect(inbox).toHaveLength(1);
        expect(inbox[0]).toMatchObject({ from: "Alice", content: "hello" });
    });

    it("falls through to the inbox after a peer's wake-stream evicts it (no silent loss)", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        // Bob comes online (in production this also opens his GET SSE wake-stream).
        await callTool(req("register"), fakeSession({ voiceName: "Bob", sessionId: "bob-s" }));
        expect(deps.presence.has("Bob")).toBe(true);

        // His wake-stream drops — v1.2.1 evicts his presence by session id the
        // instant the GET stream closes. Before the fix this never happened:
        // the registry kept a dead wake handle, the next send was pushed into a
        // closed stream, server.notification didn't throw, and the message was
        // reported delivered and silently lost.
        deps.presence.removeBySession("bob-s");

        const res = await callTool(
            req("send", { to: "Bob", content: "still here?" }),
            fakeSession({ voiceName: "Alice" }),
        );

        // Not lost: reported queued, and retrievable via get_recent.
        expect(payload(res)).toEqual({ ok: true, delivered: false, queued: true });
        const got = await callTool(req("get_recent"), fakeSession({ voiceName: "Bob" }));
        const messages = payload(got).messages as Array<Record<string, unknown>>;
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ from: "Alice", content: "still here?" });
    });

    it("errors content_too_large past MAX_CONTENT", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        const res = await callTool(
            req("send", { to: "Bob", content: "x".repeat(MAX_CONTENT + 1) }),
            fakeSession({ voiceName: "Alice" }),
        );
        expect(res.isError).toBe(true);
        expect((payload(res).error as { code: string }).code).toBe("content_too_large");
    });

    it("errors invalid_arguments when to/content are missing", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        const session = fakeSession({ voiceName: "Alice" });

        const noTo = await callTool(req("send", { content: "hi" }), session);
        expect((payload(noTo).error as { code: string }).code).toBe("invalid_arguments");

        const noContent = await callTool(req("send", { to: "Bob" }), session);
        expect((payload(noContent).error as { code: string }).code).toBe("invalid_arguments");
    });

    it("errors invalid_name for a bad target name", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        const res = await callTool(
            req("send", { to: "bad name!", content: "hi" }),
            fakeSession({ voiceName: "Alice" }),
        );
        expect(res.isError).toBe(true);
        expect((payload(res).error as { code: string }).code).toBe("invalid_name");
    });
});

describe("callTool — who_is_online", () => {
    it("returns the roster", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        await callTool(req("register"), fakeSession({ voiceName: "Alice", sessionId: "a" }));
        await callTool(req("register"), fakeSession({ voiceName: "Bob", sessionId: "b" }));

        const res = await callTool(req("who_is_online"), fakeSession());

        expect(payload(res)).toEqual({
            voices: [
                { name: "Alice", online: true },
                { name: "Bob", online: true },
            ],
        });
    });
});

describe("callTool — get_recent", () => {
    it("errors missing_voice_name when the caller has no name", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        const res = await callTool(req("get_recent"), fakeSession());
        expect(res.isError).toBe(true);
        expect((payload(res).error as { code: string }).code).toBe("missing_voice_name");
    });

    it("returns inbox messages newest-last with from/content/at", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        deps.inbox.add("Alice", "Bob", "first");
        deps.inbox.add("Alice", "Carol", "second");

        const res = await callTool(req("get_recent"), fakeSession({ voiceName: "Alice" }));

        const messages = payload(res).messages as Array<Record<string, unknown>>;
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({ from: "Bob", content: "first" });
        expect(messages[1]).toMatchObject({ from: "Carol", content: "second" });
        // `at` is serialized as an ISO string.
        expect(typeof messages[1]?.at).toBe("string");
        expect(messages[1]?.at).toBe(new Date(messages[1]?.at as string).toISOString());
    });

    it("clamps n: default 10, max 50, non-finite -> default", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        for (let i = 0; i < 60; i++) deps.inbox.add("Alice", "Bob", `m${i}`);
        const session = fakeSession({ voiceName: "Alice" });

        // The inbox only retains 20 per name, so clamping is observed against that.
        const def = await callTool(req("get_recent"), session);
        expect((payload(def).messages as unknown[]).length).toBe(10);

        const maxed = await callTool(req("get_recent", { n: 999 }), session);
        expect((payload(maxed).messages as unknown[]).length).toBe(20);

        const nonFinite = await callTool(req("get_recent", { n: Number.NaN }), session);
        expect((payload(nonFinite).messages as unknown[]).length).toBe(10);
    });
});

describe("callTool — unknown tool", () => {
    it("returns internal_error", async () => {
        const deps = makeDeps();
        const callTool = createCallTool(deps);
        const res = await callTool(req("does_not_exist"), fakeSession());
        expect(res.isError).toBe(true);
        expect((payload(res).error as { code: string }).code).toBe("internal_error");
    });
});

describe("isApiKeyValid", () => {
    it("accepts the correct key", () => {
        expect(isApiKeyValid("s3cr3t-key", "s3cr3t-key")).toBe(true);
    });

    it("rejects a wrong key of the same length", () => {
        expect(isApiKeyValid("s3cr3t-key", "s3cr3t-keY")).toBe(false);
    });

    it("rejects a key of the wrong length (constant-time, no length leak)", () => {
        expect(isApiKeyValid("short", "a-much-longer-expected-key")).toBe(false);
    });

    it("rejects a missing key", () => {
        expect(isApiKeyValid(undefined, "expected")).toBe(false);
        expect(isApiKeyValid("", "expected")).toBe(false);
    });
});
