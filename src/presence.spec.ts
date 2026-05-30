import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PresenceRegistry } from "./presence.js";

const fakeServer = (): Server => ({}) as unknown as Server;

describe("PresenceRegistry", () => {
    it("registers and lists a peer", () => {
        const p = new PresenceRegistry();
        const r = p.register("Alice", fakeServer(), "s1");
        expect(r).not.toBeNull();
        expect(r?.tookOver).toBe(false);
        expect(p.has("Alice")).toBe(true);
        expect(p.list()).toEqual([{ name: "Alice", online: true }]);
    });

    it("takes over a name on re-register (last wins)", () => {
        const p = new PresenceRegistry();
        p.register("Alice", fakeServer(), "s1");
        const r = p.register("Alice", fakeServer(), "s2");
        expect(r?.tookOver).toBe(true);
        expect(p.get("Alice")?.sessionId).toBe("s2");
    });

    it("removeBySession only removes the matching session (stale onclose is a no-op)", () => {
        const p = new PresenceRegistry();
        p.register("Alice", fakeServer(), "s2"); // current session is s2
        p.removeBySession("s1"); // a late onclose for the OLD session
        expect(p.has("Alice")).toBe(true); // must NOT evict the takeover
        p.removeBySession("s2");
        expect(p.has("Alice")).toBe(false);
    });

    it("removes by name", () => {
        const p = new PresenceRegistry();
        p.register("Alice", fakeServer(), "s1");
        p.remove("Alice");
        expect(p.has("Alice")).toBe(false);
    });
});
