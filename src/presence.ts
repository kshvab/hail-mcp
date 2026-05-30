import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { log } from "./log.js";

/** One live peer connection. The captured `server` is the wake push handle. */
export interface PresenceEntry {
    name: string;
    server: Server;
    sessionId: string;
    connectedAt: Date;
}

/** Public view of a peer — no internal handles. */
export interface VoiceSummary {
    name: string;
    online: boolean;
}

/**
 * In-RAM registry of connected peers, keyed by name. Source of truth for who is
 * online. Presence follows the MCP connection lifecycle:
 *   - register() binds a peer (capturing its push handle),
 *   - transport close, a failed push, or a re-register takeover removes it.
 * Last-register-wins: a reconnecting peer reclaims its name (the transport can't
 * always observe a silent drop, so re-register is the reliable self-heal).
 */
/** Cap on concurrent online peers — bounds the in-RAM map against a sprayer. */
const MAX_PEERS = 1000;

export class PresenceRegistry {
    private readonly entries = new Map<string, PresenceEntry>();

    /**
     * Bind a peer online. Returns `null` if the registry is at capacity and this
     * is a NEW name (a re-register / takeover of an existing name always
     * succeeds — it replaces, it doesn't grow the map).
     */
    register(
        name: string,
        server: Server,
        sessionId: string,
    ): { entry: PresenceEntry; tookOver: boolean } | null {
        const tookOver = this.entries.has(name);
        if (!tookOver && this.entries.size >= MAX_PEERS) {
            log.warn(`presence at capacity (${MAX_PEERS}) — rejecting new peer "${name}"`);
            return null;
        }
        if (tookOver) {
            log.debug(`re-register of "${name}" — taking over the prior session`);
        }
        const entry: PresenceEntry = { name, server, sessionId, connectedAt: new Date() };
        this.entries.set(name, entry);
        return { entry, tookOver };
    }

    remove(name: string): void {
        this.entries.delete(name);
    }

    /** Remove whichever peer owns this session id (guards against stale onclose). */
    removeBySession(sessionId: string): void {
        for (const [name, entry] of this.entries) {
            if (entry.sessionId === sessionId) {
                this.entries.delete(name);
                return;
            }
        }
    }

    get(name: string): PresenceEntry | undefined {
        return this.entries.get(name);
    }

    has(name: string): boolean {
        return this.entries.has(name);
    }

    list(): VoiceSummary[] {
        return Array.from(this.entries.keys(), (name) => ({ name, online: true }));
    }
}
