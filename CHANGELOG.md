# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-06-10

### Fixed

- **Sends to a peer whose wake-stream had silently dropped were marked `delivered` and lost.** The GET SSE stream is a peer's wake channel, but its closing did not evict the peer from the presence registry (`transport.onclose` does not fire on a bare GET-stream death). The registry kept a dead wake handle, so the next `send` pushed a `notifications/claude/channel` into a closed stream; `server.notification` did not throw, the message was reported `delivered: true`, and it reached neither the peer nor the inbox. The server now evicts a peer's presence the instant its GET SSE stream closes or errors (keyed by session id, so a newer session that has already taken the name over is left untouched). Such sends now miss and fall through to the inbox (`queued: true`), retrievable via `get_recent` — no silent loss. Operator note: the manual `/mcp reconnect` workaround is no longer required to recover a stalled receiver.

## [1.2.0] - 2026-05-30

### Added

- **`get_recent({ n? })` — a pull path for non-wakeable peers (e.g. cloud instances).** Every `send` now also drops the message into the receiver's in-RAM inbox (keyed by name, surviving disconnect), so a session that can't be woken by a push registers a name, others send to it while it's away, and it polls `get_recent` to read them. Wakeable sessions still get the live wake and rarely need it; the inbox doubles as a fallback for any missed push. `send` now returns `{ ok, delivered, queued }`. The inbox is bounded twice over (per-name ring of 20, capped number of distinct inboxes). No way to detect local vs cloud is needed — the push is best-effort and the inbox is universal.
- **`register({ name })`** now accepts an explicit name, letting a session that connected without one come online (the session adopts the name). Named connections still auto-online and need not call it.

### Changed

- A connection that arrives with a name is bound on connect (auto-online); `register()` is no longer a required handshake. Un-expanded `${VAR}` placeholder names (operator forgot the env var) are rejected as nameless.

## [1.1.0] - 2026-05-30

### Added

- **Per-launch voice name via the `?name=` URL query param.** The name is no longer pinned in the shared MCP config — it is read from `…/mcp?name=<name>` (with the `X-Voice-Name` header kept as a fallback). This lets multiple sessions spawned from one shared config each take their own identity by setting `HAIL_NAME` per launch (Claude Code expands `${HAIL_NAME}` in the config URL). Chosen over a header because CC's `${ENV}` expansion has a known bug for HTTP-transport header values but works in the URL. Verified live (env → URL → server). Backward-compatible.

## [1.0.0] - 2026-05-30

First release. A symmetric, hosted MCP channel that lets Claude Code sessions wake each other.

### Added

- A single-process MCP server (plain TypeScript, raw Node `http` + the `@modelcontextprotocol/sdk` streamable-HTTP transport) that declares the `claude/channel` capability and pushes server-initiated wake notifications to connected sessions. One runtime dependency.
- Three tools: `register`, `who_is_online`, `send({ to, content })`. Symmetric model — replies are ordinary sends back; no request/reply machinery.
- Presence by connection (in-RAM), bound on connect from the `X-Voice-Name` header with last-register-wins takeover so a reconnecting peer reclaims its name.
- Single shared `X-API-KEY` gate (constant-time compare); server refuses to start with an unset/placeholder key.
- In-RAM FIFO audit of delivered messages.
- The two non-obvious requirements to actually wake a Claude Code session over HTTP, documented in the README "Implementation notes": an SSE keepalive (prevents session cycling) and a fakechat-shaped notification `meta` (`chat_id`/`message_id`/`user`/ISO-`ts`).
- Docs: README (incl. implementation notes for channel builders), SECURITY, CONTRIBUTING, CODE_OF_CONDUCT.
- Tests: unit suites for presence, push, ping-log, identity, event-store, and the load-bearing `buildWake` meta shape.

### Known limitations (v1)

- Single shared key, not bound to identity (name impersonation possible) — identity-bound keys planned for v2.
- In-memory state; best-effort delivery (no read receipt); self-hosted channel requires the `--dangerously-load-development-channels` flag; no TLS by default.

[1.2.0]: https://github.com/kshvab/hail-mcp/releases/tag/v1.2.0
[1.1.0]: https://github.com/kshvab/hail-mcp/releases/tag/v1.1.0
[1.0.0]: https://github.com/kshvab/hail-mcp/releases/tag/v1.0.0
