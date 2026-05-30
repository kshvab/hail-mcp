import type { IncomingMessage } from "node:http";

/** Query param / header a peer uses to self-describe its name. No central enum
 * — identity is self-declared; the shared X-API-KEY gates access. */
export const VOICE_NAME_HEADER = "x-voice-name";
export const VOICE_NAME_QUERY = "name";

/** A name that still looks like an un-expanded config placeholder, e.g.
 * `${HAIL_NAME}` — means the operator forgot to set the env var before
 * launch. Treat as absent (better a clear voice=? than a literal-placeholder
 * peer that others can't meaningfully reach). */
function isUnexpandedPlaceholder(name: string): boolean {
    return /^\$\{[^}]*\}$/.test(name) || name.includes("${");
}

/** Max name length. */
export const MAX_NAME_LEN = 64;
/**
 * Allowed name charset. Names are attacker-controlled and echoed into
 * who_is_online, the inbox `from`, and the `[from <name>]` wake tag the threat
 * model leans on — so they must not carry whitespace, newlines, control chars,
 * or `<>[]`-style delimiters that could forge that provenance. Restrict to a
 * safe, readable charset.
 */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Validate + normalize a self-declared name. Returns the trimmed name, or
 * `undefined` if it is absent, an un-expanded `${VAR}` placeholder, too long,
 * or contains characters outside the safe charset.
 */
export function sanitizeName(value: string | undefined): string | undefined {
    const name = value?.trim();
    if (!name) return undefined;
    if (isUnexpandedPlaceholder(name)) return undefined;
    if (name.length > MAX_NAME_LEN) return undefined;
    if (!NAME_RE.test(name)) return undefined;
    return name;
}

/**
 * Extract the peer's self-described name from a request.
 *
 * PRIMARY: the `?name=` URL query param. SECONDARY: the `X-Voice-Name` header.
 *
 * Why query-first: the name must be settable PER LAUNCH (so multiple instances
 * spawned from one shared MCP config don't collide on a single name). Claude
 * Code expands `${ENV}` in the MCP config — reliably in the URL field
 * (`.../mcp?name=${HAIL_NAME}`), but NOT in HTTP-transport header values
 * (a known CC bug). So the URL query is the dependable per-launch surface; the
 * header stays as a fallback for clients that set it directly.
 */
export function extractVoiceName(req: IncomingMessage): string | undefined {
    // Query param first.
    try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const fromQuery = sanitizeName(url.searchParams.get(VOICE_NAME_QUERY) ?? undefined);
        if (fromQuery) return fromQuery;
    } catch {
        // malformed url — fall through to header
    }
    // Header fallback.
    const raw = req.headers[VOICE_NAME_HEADER];
    return sanitizeName(Array.isArray(raw) ? raw[0] : raw);
}
