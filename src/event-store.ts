import type {
    EventStore,
    EventId,
    StreamId,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * In-memory EventStore — resumability for the standalone GET SSE stream.
 *
 * Event ids encode their streamId (`${streamId}::${counter}`) so replay can
 * recover the stream from a bare `lastEventId` and resend only that stream's
 * later events, in order. In-memory only (history dies with the process — every
 * transport dies with it too, so there is nothing to resume across a restart).
 */
export class InMemoryEventStore implements EventStore {
    private seq = 0;
    private readonly events: { eventId: EventId; streamId: StreamId; message: JSONRPCMessage }[] =
        [];

    /** Bound the replay buffer (newest in, oldest out). Without this a long-lived
     * session accumulates every pushed message forever — a slow memory leak. The
     * cost of the cap: a reconnect that was offline for more than this many
     * pushes replays only the most recent ones, which is fine (the keepalive
     * keeps streams alive, so reconnect gaps are small). */
    private static readonly MAX_EVENTS = 256;

    private makeEventId(streamId: StreamId): EventId {
        return `${streamId}::${this.seq++}`;
    }

    private streamIdOf(eventId: EventId): StreamId {
        const idx = eventId.lastIndexOf("::");
        return idx === -1 ? "" : eventId.slice(0, idx);
    }

    async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
        await Promise.resolve();
        const eventId = this.makeEventId(streamId);
        this.events.push({ eventId, streamId, message });
        if (this.events.length > InMemoryEventStore.MAX_EVENTS) {
            this.events.splice(0, this.events.length - InMemoryEventStore.MAX_EVENTS);
        }
        return eventId;
    }

    async replayEventsAfter(
        lastEventId: EventId,
        { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
    ): Promise<StreamId> {
        const streamId = this.streamIdOf(lastEventId);
        if (!streamId) return streamId;

        let replaying = false;
        for (const event of this.events) {
            if (event.streamId !== streamId) continue;
            if (!replaying) {
                if (event.eventId === lastEventId) replaying = true;
                continue;
            }
            await send(event.eventId, event.message);
        }
        return streamId;
    }
}
