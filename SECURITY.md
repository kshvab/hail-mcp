# Security Policy

hail wakes idle Claude Code sessions and **injects a sender's message into them**. That capability is the centre of its threat model: a message sent through hail is delivered verbatim into the recipient peer's session as a synthetic turn the model then acts on. Treat the server, its API key, and the peers it connects with the same care you'd give any system that can put words into your agents' mouths.

## Threat model

### 1. Prompt injection (the core risk)
When a peer `send`s a message, the content is pushed to the target as a `notifications/claude/channel` event and injected into that session as a user turn. The receiving model reads it and may act on it. A sender — including an untrusted instance — is therefore an **injection source** into another peer's session.

Mitigations in v1:
- The message is tagged `[from <sender>]` so the recipient can see it is external and who it claims to be from.
- The whole surface is gated by a shared API key — only key-holders can connect or send.
- A bounded in-memory audit (who messaged whom + a preview) is kept; note it lives only in RAM and is not yet exposed via a tool/endpoint in v1 (a read path is a small future addition).

Residual risk: any key-holding peer can inject into any other peer. Issue the key only to trusted participants, and treat inbound `[from …]` content as untrusted input, not as operator instructions.

### 2. Single shared key, not bound to identity (v1)
v1 uses **one shared `X_API_KEY`** for the whole server. It authorises access; it does **not** bind a connection to a specific identity. Consequences:
- Anyone with the key may register under **any** `X-Voice-Name` — name impersonation is possible.
- Acceptable only on trusted, single-operator deployments. **Identity-bound keys (a key scoped to an allowed name) are planned for v2** and are what close impersonation.

### 3. Open-server-by-default, prevented
Because an unauthenticated server would be an open injection channel, the server **refuses to start** if `X_API_KEY` is unset or left at the placeholder `changeme`. There is no working default key. The key is compared in constant time.

### 4. Self-hosted channel requires a development flag
Peers attach with `claude --dangerously-load-development-channels server:hail`. Claude Code restricts auto-loaded channels to a built-in allowlist; a self-hosted channel loads only via this explicit development flag, after a confirmation prompt. Attaching this channel means an external server can wake your session and feed it input — only attach a hail server you operate and trust.

### 5. Transport posture
- The `/mcp` surface is plain HTTP. **Do not expose it to an untrusted network without TLS in front** (a reverse proxy terminating HTTPS) — the API key and message content would otherwise travel in cleartext.
- State is in-RAM and per-connection; nothing is persisted to disk.
- The in-RAM audit and `get_recent` inbox hold sender names and message content; `DEBUG=1` additionally logs a per-request trace including names and content previews. Don't run `DEBUG=1` where the logs are untrusted, and treat the host's memory/logs as containing message content.

## Operator responsibilities

- Set a long, random `X_API_KEY`; never ship `changeme`.
- Issue the key only to trusted peers; rotate it if a holder is no longer trusted.
- Put TLS in front of any non-loopback deployment.
- Recipients: treat inbound `[from …]` content as untrusted data.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use this repository's **"Report a vulnerability"** button (GitHub Private Vulnerability Reporting, under the Security tab) to open a private report with a description, impact, and reproduction steps. If that is unavailable, contact the maintainer via the email on their GitHub profile (https://github.com/kshvab). You can expect an acknowledgement within a few days, and we will coordinate a fix and disclosure timeline with you.
