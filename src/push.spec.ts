import { jest } from "@jest/globals";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PresenceRegistry } from "./presence.js";
import { ChannelPush } from "./push.js";

const meta = { chat_id: "A", message_id: "m1", user: "A", ts: "2026-01-01T00:00:00.000Z" };

describe("ChannelPush", () => {
    it("pushes a notifications/claude/channel to an online peer and returns true", async () => {
        const presence = new PresenceRegistry();
        const notification = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
        presence.register("Bob", { notification } as unknown as Server, "s1");

        const ok = await new ChannelPush(presence).push("Bob", "hi", meta);

        expect(ok).toBe(true);
        expect(notification).toHaveBeenCalledWith({
            method: "notifications/claude/channel",
            params: { content: "hi", meta },
        });
    });

    it("returns false for an offline peer (no throw)", async () => {
        const ok = await new ChannelPush(new PresenceRegistry()).push("Nobody", "hi", meta);
        expect(ok).toBe(false);
    });

    it("evicts the stale entry and returns false when the push throws", async () => {
        const presence = new PresenceRegistry();
        const notification = jest.fn<() => Promise<void>>().mockRejectedValue(new Error("stream gone"));
        presence.register("Bob", { notification } as unknown as Server, "s1");

        const ok = await new ChannelPush(presence).push("Bob", "hi", meta);

        expect(ok).toBe(false);
        expect(presence.has("Bob")).toBe(false);
    });
});
