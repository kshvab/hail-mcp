import { jest } from "@jest/globals";
import { loadConfig } from "./config.js";

/**
 * loadConfig reads the ambient environment and exits on an unsafe key. To keep
 * the test hermetic we:
 *   - stub process.loadEnvFile so a developer's real .env can't bleed in,
 *   - stub process.exit so a fail-fast becomes an observable throw (and never
 *     actually tears down the jest worker),
 *   - stub console.error to keep the FATAL banner out of the test output,
 *   - snapshot + restore the relevant env vars around each case.
 */
describe("loadConfig — fail-fast", () => {
    const ORIGINAL_API_KEY = process.env.X_API_KEY;
    const ORIGINAL_PORT = process.env.PORT;

    let exitSpy: ReturnType<typeof jest.spyOn>;
    let errorSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        // Make process.exit observable: throw a sentinel so control doesn't fall
        // through into the http-server boot code paths.
        exitSpy = jest.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new Error(`process.exit(${code})`);
        }) as never);
        errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
        // Neutralize the .env read so the test only sees what we set below.
        (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }).loadEnvFile = () =>
            undefined;
        delete process.env.X_API_KEY;
        delete process.env.PORT;
    });

    afterEach(() => {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        if (ORIGINAL_API_KEY === undefined) delete process.env.X_API_KEY;
        else process.env.X_API_KEY = ORIGINAL_API_KEY;
        if (ORIGINAL_PORT === undefined) delete process.env.PORT;
        else process.env.PORT = ORIGINAL_PORT;
    });

    it("exits when X_API_KEY is unset", () => {
        expect(() => loadConfig()).toThrow("process.exit(1)");
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when X_API_KEY is still the 'changeme' placeholder", () => {
        process.env.X_API_KEY = "changeme";
        expect(() => loadConfig()).toThrow("process.exit(1)");
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits on an invalid PORT", () => {
        process.env.X_API_KEY = "a-strong-key";
        process.env.PORT = "not-a-port";
        expect(() => loadConfig()).toThrow("process.exit(1)");
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits on an out-of-range PORT", () => {
        process.env.X_API_KEY = "a-strong-key";
        process.env.PORT = "70000";
        expect(() => loadConfig()).toThrow("process.exit(1)");
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("returns { port, apiKey } on a good env (default port)", () => {
        process.env.X_API_KEY = "a-strong-key";
        const config = loadConfig();
        expect(config).toEqual({ port: 9091, apiKey: "a-strong-key" });
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("returns the configured PORT when set", () => {
        process.env.X_API_KEY = "a-strong-key";
        process.env.PORT = "8080";
        const config = loadConfig();
        expect(config).toEqual({ port: 8080, apiKey: "a-strong-key" });
        expect(exitSpy).not.toHaveBeenCalled();
    });
});
