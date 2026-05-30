/**
 * Tiny dependency-free logger.
 *
 * Lifecycle/info/warn/error always print. The verbose per-request wire trace and
 * per-push trace print only when `DEBUG=1` (or `DEBUG=true`) — useful when
 * diagnosing the channel handshake, off by the noise otherwise.
 */

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

function stamp(level: string): string {
    return `${new Date().toISOString()} ${level} [hail]`;
}

export const log = {
    info(message: string): void {
        console.log(`${stamp("info")} ${message}`);
    },
    warn(message: string): void {
        console.warn(`${stamp("warn")} ${message}`);
    },
    error(message: string, err?: unknown): void {
        let extra = "";
        if (err instanceof Error) {
            extra = ` ${err.stack ?? err.message}`;
        } else if (err !== undefined) {
            extra = typeof err === "string" ? ` ${err}` : ` ${JSON.stringify(err)}`;
        }
        console.error(`${stamp("error")} ${message}${extra}`);
    },
    /** Verbose trace — only when DEBUG is enabled. */
    debug(message: string): void {
        if (DEBUG) console.log(`${stamp("debug")} ${message}`);
    },
    /** Whether verbose tracing is on (e.g. to attach extra per-request logs). */
    enabled: DEBUG,
};
