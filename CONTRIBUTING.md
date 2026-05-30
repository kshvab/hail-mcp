# Contributing to hail

Thanks for your interest. hail is a small, focused MCP server; contributions that keep it small and focused are the most welcome.

## Dev setup

```bash
npm install
cp .env.example .env     # set a strong X_API_KEY
npm run build
npm start                # node dist/server.js
```

- `npm run typecheck` — strict `tsc --noEmit` (keep it green; the strict config is intentional).
- `npm test` — unit/smoke specs (jest, ESM).
- `npm run lint` / `npm run format` — eslint + prettier.
- `DEBUG=1 npm start` — verbose per-request wire/push trace.

## Architecture in one breath

Plain TypeScript, no framework, no database. `src/server.ts` is a raw `http.Server` that hands `/mcp` requests to a per-session `@modelcontextprotocol/sdk` streamable-HTTP transport. State is in RAM: `presence.ts` (who's online), `ping-log.ts` (audit ring buffer). `push.ts` emits the wake; `channel-message.ts` builds the load-bearing fakechat-shaped `meta`.

**Before touching the wake path, read the "Implementation notes" section of the README** — the raw-http requirement, the SSE keepalive, and the exact `meta` shape are load-bearing and easy to break.

## Conventions

- Keep the v1 surface small — `register` / `who_is_online` / `send`. New tools need a clear reason and a JSON-schema input.
- Anything touching the auth gate, the push/keepalive path, or the notification `meta` is security- and wake-sensitive — describe how you verified it in the PR (unit test + a live wake check against a real Claude Code session).

## PRs

- Keep `typecheck`, `test`, and `lint` green.
- No real keys, hosts, or private data in code, tests, or docs.
- Update README / SECURITY.md if you change the tool surface or the security posture.
