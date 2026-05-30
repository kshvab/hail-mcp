/** One stored incoming message — sender name, the text, and when it arrived. */
export interface InboxMessage {
    from: string;
    content: string;
    at: Date;
}

/** Per-receiver ring capacity — newest in, oldest out. */
const MAX_PER_NAME = 20;
/** Cap on distinct inboxes — least-recently-active name is evicted past this. */
const MAX_NAMES = 500;

/**
 * Per-receiver message inbox, keyed by name, held in RAM and SURVIVING
 * disconnect (unlike presence). This is the pull path: a non-wakeable peer (a
 * cloud instance that can call tools but can't be woken by a push) registers a
 * name, others `send` to it while it's away, and it later polls `get_recent`.
 *
 * Every `send` appends here regardless of whether the live push landed, so the
 * inbox is both the cloud path and a fallback for any missed wake. Bounded twice
 * over: each name keeps only its last MAX_PER_NAME messages, and the number of
 * distinct name-inboxes is capped (oldest-active evicted) so it can't grow
 * without limit.
 */
export class Inbox {
    /** name -> ring of recent messages. Map insertion order == activity order. */
    private readonly boxes = new Map<string, InboxMessage[]>();

    /** Append a message to `to`'s inbox (newest in, oldest out past capacity). */
    add(to: string, from: string, content: string): void {
        let box = this.boxes.get(to);
        if (box) {
            // Re-insert so this name is now most-recently-active (for eviction).
            this.boxes.delete(to);
        } else {
            if (this.boxes.size >= MAX_NAMES) {
                const oldest = this.boxes.keys().next().value;
                if (oldest !== undefined) this.boxes.delete(oldest);
            }
            box = [];
        }
        this.boxes.set(to, box);
        box.push({ from, content, at: new Date() });
        if (box.length > MAX_PER_NAME) box.splice(0, box.length - MAX_PER_NAME);
    }

    /** The last `n` messages for `name` (newest last), or [] if none. */
    recent(name: string, n: number): InboxMessage[] {
        const box = this.boxes.get(name);
        if (!box) return [];
        const count = Math.max(0, Math.min(n, box.length));
        return box.slice(box.length - count);
    }
}
