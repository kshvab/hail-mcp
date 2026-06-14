import { Inbox } from "./inbox.js";

describe("Inbox", () => {
    it("returns [] for an unknown name", () => {
        expect(new Inbox().recent("nobody", 10)).toEqual([]);
    });

    it("stores messages with from + content, newest last", () => {
        const ix = new Inbox();
        ix.add("Alice", "Bob", "one");
        ix.add("Alice", "Carol", "two");
        const got = ix.recent("Alice", 10);
        expect(got.map((m) => [m.from, m.content])).toEqual([
            ["Bob", "one"],
            ["Carol", "two"],
        ]);
        expect(got[0].at).toBeInstanceOf(Date);
    });

    it("keeps only the last 10 per receiver (ring: newest in, oldest out)", () => {
        const ix = new Inbox();
        for (let i = 0; i < 25; i++) ix.add("Alice", "Bob", `m${i}`);
        const got = ix.recent("Alice", 100);
        expect(got).toHaveLength(10);
        expect(got[0].content).toBe("m15"); // m0..m14 dropped
        expect(got[9].content).toBe("m24");
    });

    it("recent(n) returns at most n, newest", () => {
        const ix = new Inbox();
        for (let i = 0; i < 5; i++) ix.add("Alice", "Bob", `m${i}`);
        expect(ix.recent("Alice", 2).map((m) => m.content)).toEqual(["m3", "m4"]);
    });

    it("isolates inboxes by receiver name", () => {
        const ix = new Inbox();
        ix.add("Alice", "Bob", "for-echo");
        ix.add("Carol", "Bob", "for-sam");
        expect(ix.recent("Alice", 10).map((m) => m.content)).toEqual(["for-echo"]);
        expect(ix.recent("Carol", 10).map((m) => m.content)).toEqual(["for-sam"]);
    });
});
