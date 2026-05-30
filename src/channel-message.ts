import { randomUUID } from "node:crypto";
import type { ChannelPushMeta } from "./push.js";

/**
 * Build the wrapped content + `meta` for a wake from `from` carrying `content`.
 *
 * Pure + tested because the `meta` SHAPE is load-bearing: Claude Code builds the
 * inbound `<channel source=... chat_id=... message_id=... user=... ts=...>` tag
 * from these fields, and if any are missing or `ts` is not an ISO string it
 * silently drops the wake (the bug that cost an entire debugging session).
 * Mirrors the working fakechat channel exactly.
 */
export function buildWake(
    from: string,
    content: string,
): { wrapped: string; meta: ChannelPushMeta } {
    const wrapped = `[from ${from}] ${content}\n\n(to reply: send to="${from}")`;
    const meta: ChannelPushMeta = {
        chat_id: from,
        message_id: randomUUID(),
        user: from,
        ts: new Date().toISOString(),
    };
    return { wrapped, meta };
}
