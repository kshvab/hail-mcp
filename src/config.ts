/** Plain env config. No framework. */

const INSECURE_DEFAULT_API_KEY = "changeme";

export interface Config {
    port: number;
    apiKey: string;
}

/**
 * Read + validate config from the environment. Fails fast on an unsafe key — an
 * open server is an open prompt-injection channel (a sender's message is
 * injected verbatim into the recipient's session).
 */
export function loadConfig(): Config {
    // Load a local .env if present (Node >=20.12 built-in; no dependency).
    try {
        (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
    } catch {
        // No .env file (or unreadable) — fall back to the ambient environment.
    }

    const apiKey = process.env.X_API_KEY ?? "";
    if (!apiKey || apiKey === INSECURE_DEFAULT_API_KEY) {
        console.error(
            "[hail] FATAL: X_API_KEY is unset or still the placeholder " +
                `"${INSECURE_DEFAULT_API_KEY}". Set a strong X_API_KEY before starting.`,
        );
        process.exit(1);
    }
    const port = Number.parseInt(process.env.PORT ?? "9091", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`[hail] FATAL: invalid PORT "${process.env.PORT}". Set a port in 1..65535.`);
        process.exit(1);
    }
    return { port, apiKey };
}
