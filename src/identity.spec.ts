import type { IncomingMessage } from "node:http";
import { extractVoiceName } from "./identity.js";

const req = (headers: Record<string, unknown>, url?: string): IncomingMessage =>
    ({ headers, url }) as unknown as IncomingMessage;

describe("extractVoiceName", () => {
    // ── header (fallback) ──────────────────────────────────────────────────
    it("reads and trims the X-Voice-Name header", () => {
        expect(extractVoiceName(req({ "x-voice-name": "  Alice  " }))).toBe("Alice");
    });

    it("takes the first value when the header is repeated", () => {
        expect(extractVoiceName(req({ "x-voice-name": ["Alice", "Other"] }))).toBe("Alice");
    });

    it("returns undefined when absent or blank", () => {
        expect(extractVoiceName(req({}))).toBeUndefined();
        expect(extractVoiceName(req({ "x-voice-name": "   " }))).toBeUndefined();
    });

    // ── query param (primary, per-launch) ──────────────────────────────────
    it("reads and trims the ?name= query param", () => {
        expect(extractVoiceName(req({}, "/mcp?name=%20Carol%20"))).toBe("Carol");
    });

    it("prefers the query param over the header (per-launch wins)", () => {
        expect(extractVoiceName(req({ "x-voice-name": "Shared" }, "/mcp?name=Carol"))).toBe("Carol");
    });

    it("falls back to the header when the query param is absent or blank", () => {
        expect(extractVoiceName(req({ "x-voice-name": "Alice" }, "/mcp"))).toBe("Alice");
        expect(extractVoiceName(req({ "x-voice-name": "Alice" }, "/mcp?name="))).toBe("Alice");
    });

    it("returns undefined when neither is present", () => {
        expect(extractVoiceName(req({}, "/mcp"))).toBeUndefined();
    });

    // ── un-expanded placeholder (operator forgot to set the env var) ────────
    it("rejects an un-expanded ${VAR} placeholder (query or header)", () => {
        expect(extractVoiceName(req({}, "/mcp?name=%24%7BHAIL_NAME%7D"))).toBeUndefined();
        expect(extractVoiceName(req({ "x-voice-name": "${HAIL_NAME}" }))).toBeUndefined();
    });

    // ── validation: charset + length (forge-resistant provenance) ──────────
    it("rejects unsafe characters and over-length names", () => {
        expect(extractVoiceName(req({}, "/mcp?name=bad%20name"))).toBeUndefined(); // space
        expect(extractVoiceName(req({ "x-voice-name": "[from boss]" }))).toBeUndefined(); // tag delimiters
        expect(extractVoiceName(req({ "x-voice-name": "a\nb" }))).toBeUndefined(); // newline
        expect(extractVoiceName(req({ "x-voice-name": "x".repeat(65) }))).toBeUndefined(); // too long
    });

    it("accepts a safe-charset name", () => {
        expect(extractVoiceName(req({ "x-voice-name": "impl-7f3a.bot_1" }))).toBe("impl-7f3a.bot_1");
    });
});
