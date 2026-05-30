import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryEventStore } from "./event-store.js";

const msg = (n: number): JSONRPCMessage => ({
    jsonrpc: "2.0",
    method: "notifications/test",
    params: { n },
});

describe("InMemoryEventStore", () => {
    it("replays only events stored AFTER lastEventId, in order, for the same stream", async () => {
        const store = new InMemoryEventStore();
        const e1 = await store.storeEvent("S", msg(1));
        const e2 = await store.storeEvent("S", msg(2));
        const e3 = await store.storeEvent("S", msg(3));

        const sent: string[] = [];
        const streamId = await store.replayEventsAfter(e1, {
            send: async (id) => {
                sent.push(id);
            },
        });

        expect(streamId).toBe("S");
        expect(sent).toEqual([e2, e3]);
    });

    it("isolates streams — does not replay another stream's events", async () => {
        const store = new InMemoryEventStore();
        const a1 = await store.storeEvent("A", msg(1));
        await store.storeEvent("B", msg(2));

        const sent: string[] = [];
        await store.replayEventsAfter(a1, {
            send: async (id) => {
                sent.push(id);
            },
        });

        expect(sent).toEqual([]); // nothing after a1 in stream A
    });

    it("replays nothing for an unrecoverable lastEventId", async () => {
        const store = new InMemoryEventStore();
        const sent: string[] = [];
        const streamId = await store.replayEventsAfter("no-stream-id", {
            send: async (id) => {
                sent.push(id);
            },
        });
        expect(streamId).toBe("");
        expect(sent).toEqual([]);
    });

    it("bounds the buffer (does not grow without limit)", async () => {
        const store = new InMemoryEventStore();
        for (let i = 0; i < 1000; i++) await store.storeEvent("s", msg(i));
        // Replaying from the very first id finds at most the retained window —
        // the oldest events were evicted rather than kept forever.
        const sent: string[] = [];
        await store.replayEventsAfter("s::0", {
            send: async (id) => {
                sent.push(id);
            },
        });
        expect(sent.length).toBeLessThanOrEqual(256);
    });
});
