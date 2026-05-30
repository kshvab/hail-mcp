import { buildWake } from "./channel-message.js";

describe("buildWake", () => {
    it("wraps content with the [from X] tag and a reply hint", () => {
        const { wrapped } = buildWake("Alice", "hello there");
        expect(wrapped).toContain("[from Alice] hello there");
        expect(wrapped).toContain('(to reply: send to="Alice")');
    });

    it("builds the load-bearing fakechat-shaped meta with an ISO ts", () => {
        const { meta } = buildWake("Alice", "hi");
        expect(meta.chat_id).toBe("Alice");
        expect(meta.user).toBe("Alice");
        expect(typeof meta.message_id).toBe("string");
        expect(meta.message_id.length).toBeGreaterThan(10);
        // ts MUST be an ISO date string — Claude Code drops the wake otherwise.
        expect(meta.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(Number.isNaN(Date.parse(meta.ts))).toBe(false);
    });
});
