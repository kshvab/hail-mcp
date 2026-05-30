export interface PingLogEntry {
    from: string;
    to: string;
    preview: string;
    at: Date;
}

const PREVIEW_MAX = 280;
const MAX_ENTRIES = 500;

/**
 * In-RAM FIFO audit of delivered messages (preview only). Bounded ring buffer —
 * no database: presence is already in-RAM and a restart drops every connection,
 * so durable audit would outlive its sessions for no benefit.
 */
export class PingLog {
    private readonly entries: PingLogEntry[] = [];

    log(from: string, to: string, content: string): void {
        this.entries.push({ from, to, preview: content.slice(0, PREVIEW_MAX), at: new Date() });
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        }
    }

    recent(peer: string, limit = 50): PingLogEntry[] {
        return this.entries
            .filter((e) => e.from === peer || e.to === peer)
            .slice(-limit)
            .reverse();
    }

    size(): number {
        return this.entries.length;
    }
}
