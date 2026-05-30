import { PingLog } from "./ping-log.js";

describe("PingLog", () => {
    it("records traffic and returns recent involving a peer, newest first", () => {
        const l = new PingLog();
        l.log("A", "B", "hello");
        l.log("B", "A", "hi");
        expect(l.size()).toBe(2);
        expect(l.recent("A").map((e) => e.preview)).toEqual(["hi", "hello"]);
    });

    it("truncates the stored preview", () => {
        const l = new PingLog();
        l.log("A", "B", "x".repeat(1000));
        expect(l.recent("A")[0]!.preview.length).toBe(280);
    });

    it("caps the ring buffer (oldest drop past capacity)", () => {
        const l = new PingLog();
        for (let i = 0; i < 600; i++) l.log("A", "B", `m${i}`);
        expect(l.size()).toBe(500);
    });
});
