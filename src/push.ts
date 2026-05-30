import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./log.js";
import type { PresenceRegistry } from "./presence.js";

/** The wake method — declaring the `claude/channel` capability makes a CC
 * client treat this server as a channel and wake on this notification. */
const CHANNEL_NOTIFICATION_METHOD = "notifications/claude/channel" as const;

/**
 * The `meta` block on a `notifications/claude/channel` push. Claude Code builds
 * the inbound `<channel source=... chat_id=... message_id=... user=... ts=...>`
 * tag from THESE fields, so the shape must match the working fakechat channel
 * exactly (chat_id + message_id + user + ts-as-ISO-string) or CC can't form the
 * tag and drops the notification (no wake).
 */
export interface ChannelPushMeta {
    chat_id: string;
    message_id: string;
    user: string;
    ts: string;
}

/**
 * Pushes the server→client wake to a specific online peer's captured raw SDK
 * Server. Single owner of the reachability decision: looks the peer up, pushes,
 * and on failure evicts the stale presence entry and reports non-delivery.
 *
 * `true` means the notification was handed to a live session stream without
 * error — best-effort push, not a read receipt.
 */
export class ChannelPush {
    constructor(private readonly presence: PresenceRegistry) {}

    async push(peerName: string, content: string, meta: ChannelPushMeta): Promise<boolean> {
        const entry = this.presence.get(peerName);
        if (!entry) return false;

        const notification: Notification = {
            method: CHANNEL_NOTIFICATION_METHOD,
            params: { content, meta },
        };

        try {
            await entry.server.notification(notification);
            log.debug(`push notifications/claude/channel -> "${peerName}"`);
            return true;
        } catch (err) {
            log.warn(
                `push to "${peerName}" failed — evicting stale entry: ${String(
                    err instanceof Error ? err.message : err,
                )}`,
            );
            this.presence.remove(peerName);
            return false;
        }
    }
}
