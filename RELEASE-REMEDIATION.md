# hail-mcp@1.2.0 — Pre-Publish Remediation Report

**For:** Pulse
**From:** OSS-readiness review (6 dimensions, 14 agents, blockers/majors adversarially verified against the actual files)
**Verdict:** 🟡 **GO-WITH-FIXES** — the repo is fundamentally sound (clean MIT licensing, no committed secrets, no copyleft deps, `npm audit` = 0 vulns, real constant-time auth gate, honest threat model, accurate README). It is **not** safe to `npm publish` as-is. Clear the 2 blockers + 2 majors, run the release checklist at the bottom, then ship.

Every item below is anchored to a `file:line` and the claim was verified by reading the actual file. Work top-down: **Blockers → Majors → Quick wins → Docs → Governance → Optional hardening.**

---

## 🔴 BLOCKERS — must fix before `npm publish`

### B1. Non-deterministic build ships stale artifacts
**Where:** `package.json:35` (`build`) and `package.json:36` (`prepublishOnly`)
**Why it's a blocker:** `build` is bare `tsc -p tsconfig.build.json`. `tsc` *never deletes* prior outputs, and `prepublishOnly` has no clean step. At review time `dist/` held an entire orphaned prior-architecture (NestJS-style) tree absent from `src/` — `app.module.js`, `main.js`, `mcp/`, `logger/`, `guards/api-key.guard.js`, `config/`, `common/`, `voiceping/`. `npm pack --dry-run` shipped **97 files / 338 kB** of that dead code (~3× the intended payload). The tree happens to be clean right now (someone rebuilt), **but cleanliness depends entirely on the publisher's local `dist/` state** — the defect recurs silently whenever local dist drifts.

**Fix:**
1. Add `rimraf` to `devDependencies`:
   ```
   npm install --save-dev rimraf
   ```
2. Edit `package.json` scripts:
   ```jsonc
   "clean": "rimraf dist",
   "build": "npm run clean && tsc -p tsconfig.build.json",
   ```
   (`prepublishOnly: "npm run build"` then becomes deterministic automatically.)

**Verify:**
```bash
rm -rf dist && npm run build
npm pack --dry-run
```
Expect only the current flat module set (~36 files: `server.js`, `config.js`, `identity.js`, `presence.js`, `inbox.js`, `push.js`, `event-store.js`, `ping-log.js`, `channel-message.js`, `log.js` + their `.d.ts`/`.map`) and **no** `mcp/`, `voiceping/`, `app.module.js`, `main.js`. Also delete the stale `dist/` from the working copy now so it can't be published by accident.

---

### B2. GitHub repo `kshvab/hail-mcp` does not resolve
**Where:** `README.md:67` (quickstart `git clone`), `package.json:19-26` (`repository`/`homepage`/`bugs`)
**Why it's a blocker:** `git ls-remote https://github.com/kshvab/hail-mcp.git` → **"Repository not found"**; the local repo has **no `origin` remote** configured. Today the quickstart's first step (`git clone …`) 404s and every homepage/bugs/issues link in the published package is dead. (Note: the README badges on lines 5–10 are static shields.io badges — those are fine and need no change.)

**Fix:** The URLs baked into the files are already correct and consistent — **no code/doc changes needed.** Just make the remote real:
```bash
git remote add origin https://github.com/kshvab/hail-mcp.git   # if not already
git push -u origin master            # ensure the public repo exists & is pushed
```
Confirm the repo is **public**.

**Verify:** `git clone https://github.com/kshvab/hail-mcp.git` succeeds from a clean dir; the `homepage` and `bugs.url` links open in a browser; the Issues tab exists.

---

## 🟠 MAJORS — fix before publish (or make a deliberate, documented call)

### M1. No usable launch path for an npm consumer
**Where:** `package.json` (no `bin`, no `main`, no `exports`); `src/server.ts:1` is `import http from "node:http";` (no shebang); README documents only clone-and-run (`README.md:67-72`).
**Why it's major:** `npm install hail-mcp` installs a package with **no documented or discoverable way to run it**. The `start` script (`node dist/server.js`) is a *dependency's* script and isn't exposed to consumers. This is an HTTP-transport server (`StreamableHTTPServerTransport`, wired via `claude mcp add --transport http … http://HOST:9091/mcp`, `README.md:91`), so a `bin` isn't *strictly* mandatory — but publishing an unrunnable artifact to npm isn't acceptable. **Pick ONE story:**

**Option (a) — make it npx-runnable (recommended if you want npm distribution):**
1. Prepend a shebang as the **first line** of `src/server.ts` so it survives the build:
   ```ts
   #!/usr/bin/env node
   ```
2. Add to `package.json`:
   ```jsonc
   "bin": { "hail-mcp": "dist/server.js" },
   ```
3. Document `npx hail-mcp` (with the required env vars) in the README quickstart.
4. Verify the built `dist/server.js` keeps the shebang and is executable: `npm pack`, install the tarball in a scratch dir, run `npx hail-mcp`.

**Option (b) — clone-and-run only:** drop the npm-publish goal: remove `prepublishOnly`, trim the `files` allowlist, and stop advertising it as an installable package. Then B1's pack-cleanliness concern only matters for the GitHub release artifact.

> Decision needed from the owner. If unsure, (a) is the conventional choice for an MCP server people are meant to run.

---

### M2. `server.ts` is entirely untested
**Where:** `src/server.ts:137` (the `callTool` dispatch) and the whole module; `src/config.ts` fail-fast paths too.
**Why it's major (not a blocker):** the code reads as correct, so publication isn't *broken* — but `server.ts` is the **highest-value, highest-regression-risk** module and has **zero coverage**. Specs exist for `presence`, `inbox`, `ping-log`, `push`, `event-store`, `identity`, `channel-message` — but none for `server.ts` or `config.ts`. Untested behavior includes:
- the constant-time auth gate (`timingSafeEqual`, `src/server.ts:315-321`) — accept **and** reject;
- HTTP routing & status codes (`/mcp`, 404/401/405, JSON-parse-400);
- session create/close lifecycle + presence-on-connect binding (`src/server.ts:256`);
- the entire `callTool` dispatch: `register` name-precedence + **takeover** + `already_online`/`presence_full`; `send` **delivered-vs-queued** with the **inbox-only-on-miss invariant** (`src/server.ts:199`) and `content_too_large`/`invalid_name`; `get_recent` clamping (`src/server.ts:213-214`); missing-name errors;
- `config.ts` `process.exit(1)` fail-fast paths (`src/config.ts:29`, `:34`).

**Fix:** `callTool` already takes a `Session`, so it's testable with a fake transport/server — refactor the auth/routing helpers to be importable, then add specs for:
- auth **accept** / **reject**;
- `register` precedence + takeover + `presence_full`;
- `send` `delivered=true` (no inbox add) vs `delivered=false` (inbox add + `queued=true`) + `content_too_large` + `invalid_name`;
- `get_recent` name-required + clamping;
- the unknown-tool path.

> This is the largest coverage gap. Strongly recommended for a first public release; coordinate with the owner if you'd rather ship v1.2.0 and land tests in v1.2.1.

---

## 🟢 QUICK WINS — small, high-value, do them in the same pass

### Q1. `SERVER_VERSION` drifted to `"1.0.0"`
**Where:** `src/server.ts:28` — `const SERVER_VERSION = "1.0.0";` passed to `new Server({ name, version })`, but `package.json` is `1.2.0`. The stale version is advertised over the MCP `initialize` handshake and will keep drifting every release.
**Fix:** read the version from `package.json` at startup (e.g. import the JSON, or inject at build) so it tracks automatically.

### Q2. Don't ship `tsconfig.build.tsbuildinfo` (and reconsider sourcemaps)
**Where:** `tsconfig.json:17` (`tsBuildInfoFile` / `incremental`). Even a clean build ships 10 `*.js.map` files **and** `dist/tsconfig.build.tsbuildinfo` (~95 kB — the **largest file in the tarball**, a pure incremental-compile cache with zero runtime value).
**Fix:** set `tsBuildInfoFile` outside `dist`, or disable `incremental` for the build config, or exclude `*.tsbuildinfo` (and optionally `*.map`) via the `files` glob / an `.npmignore`. At minimum drop the `.tsbuildinfo`.

### Q3. `send()` missing-arg returns the wrong error code
**Where:** `src/server.ts:180` returns `toolError("internal_error", "send: \`to\` and \`content\` are required strings.")`. This is a **caller** validation failure, not a server fault — and the adjacent `invalid_name`/`content_too_large` cases use accurate codes.
**Fix:** use a validation code, e.g. `invalid_arguments` (or `missing_arguments`), for consistency.

### Q4. `get_recent` n-validation doesn't reject `NaN` (latent)
**Where:** `src/server.ts:213-214`. `typeof NaN === "number"` survives the guard; `Math.max/Math.min` propagate `NaN`; `box.slice(box.length - NaN)` → `slice(NaN)` → returns the whole box. Not reachable over the wire today (JSON can't carry `NaN`), but the clamp gives a false sense of safety.
**Fix:** add `Number.isFinite(args.n)` to the guard (or coerce `NaN` to the default).

### Q5. Tag the release
**Where:** `git tag -l` is empty despite `package.json` 1.2.0 and CHANGELOG history. No way to correlate a published npm version with a commit; no provenance.
**Fix:** `git tag v1.2.0` at the release commit, push tags, and adopt `npm version` for future releases.

### Q6. Add CI
**Where:** no `.github/` directory exists. A real test suite (jest + 7 `*.spec.ts`) and `typecheck`/`lint` scripts exist, and `CONTRIBUTING.md` asks contributors to keep them green — but nothing enforces it.
**Fix:** add `.github/workflows/ci.yml` running `npm ci` → `npm run build` → `npm run typecheck` → `npm run lint` → `npm test` on Node 20 & 22. Optionally a release workflow that publishes on tag with `--provenance`.

---

## 📄 DOCS ACCURACY — README polish (all verified against the code)

- **`README.md:95`** — "temp instances use a random one" is misleading: the server **never generates names**. A nameless connection stays nameless until it calls `register({ name })` (`src/identity.ts` `extractVoiceName` + `src/server.ts` `register`). Reword to make clear the **operator/launcher supplies** the per-launch name.
- **`README.md:58`** — document `get_recent`'s **default 10 / max 50** (clamp at `src/server.ts:213-214`); the tools table currently shows `get_recent({ n? })` with no bound.
- **`README.md:55`** — `register()` returns `{ ok, name, already_online }` (`src/server.ts:169`) and a nameless sender is tagged `[from anonymous]` (`src/server.ts:192`). Optionally document the return shape and the `anonymous` fallback.
- **`README.md:62`** — add a **Development** section (`npm test` / `npm run dev` / `typecheck` / `lint`) or link `CONTRIBUTING.md` prominently; today only CONTRIBUTING mentions how to run the suite.
- **`README.md:128`** — implementation notes pin Claude Code v2.1.x (good, caveated); optionally also cite the tested `@modelcontextprotocol/sdk ^1.12.1` so the wake mechanism is reproducible.
- **`README.md:67`** — clone target is bare `hail` (`git clone … hail`) while the package is `hail-mcp`. Intentional/harmless; optionally drop the explicit `hail` for least-surprise.
- Keep the **"issue the key only to trusted peers"** warning near the README **install** step (not only in SECURITY.md) — impersonation is invisible to a casual user (`src/presence.ts:43` is last-register-wins).

---

## 🤝 GOVERNANCE / COMMUNITY

- **Confirm GitHub Private Vulnerability Reporting is actually enabled** on the repo. `SECURITY.md:42` and `CODE_OF_CONDUCT.md:17` route reports **exclusively** to the "Report a vulnerability" button, which only appears if PVR is toggled on in repo Settings → Security. If it's off, both the security-disclosure **and** CoC-enforcement channels are dead. Add an **email/alternate fallback** so a reporter is never stranded. (For a project whose entire threat model is prompt injection, a non-functional security channel is a real risk.)
- **`CODE_OF_CONDUCT.md:17`** cites Contributor Covenant 2.1 but omits the **Enforcement Guidelines** ladder (Correction / Warning / Temporary Ban / Permanent Ban) and Scope section. Either include them to match the attribution, or soften it to "adapted/abridged." Naming a maintainer contact role strengthens it.
- Add **`.github/` templates**: `ISSUE_TEMPLATE/` (bug + feature) and `PULL_REQUEST_TEMPLATE.md` mirroring the CONTRIBUTING checklist (typecheck/test/lint green; no real keys/hosts; describe verification for wake/auth/meta changes). Optionally `CODEOWNERS`.
- **`CONTRIBUTING.md:9`** uses `cp .env.example .env` / bash idioms; the author env is Windows-first. Optionally add the PowerShell equivalent (`Copy-Item .env.example .env`) or note that commands assume a POSIX shell.
- **`CONTRIBUTING.md:27`** — optionally add a short **Scope / non-goals** list so proposals can be triaged against it.

---

## ⚙️ OPTIONAL HARDENING — documented v1 trade-offs, **no fix required for release**

These are honestly disclosed in `SECURITY.md` as accepted v1 trade-offs (trusted single-operator deployments). Listed so Pulse knows they're known, not oversights:

- **Name impersonation** (`src/presence.ts:43`) — identity is self-declared; only the shared key gates access. `register` is last-register-wins, so a key-holder can take over another peer's live name, intercept their `send`s, and post as `[from A]`. Cheap v1.x hardening: **refuse a takeover while the incumbent session is still live** (only allow reclaim of a dropped name).
- **Unbounded sessions / event-store** (`src/server.ts:63`, `src/event-store.ts:30`) — `MAX_PEERS`/inbox caps exist, but the `sessions` Map and per-session `InMemoryEventStore` are uncapped. A long-lived peer accumulates every pushed `JSONRPCMessage` forever (slow leak bounded only by session lifetime); an authenticated key-holder can open arbitrarily many SSE streams. Optionally cap concurrent sessions and bound the events array (last-N per stream), mirroring the bounded ring used in `Inbox`/`PingLog`.
- **`PingLog` is write-only** (`src/ping-log.ts:26`) — `pingLog.log()` is called on every `send` (`src/server.ts:200`) but `recent()`/`size()` are never read in the runtime (only in the spec). Either surface the audit (debug/admin tool or log line), remove it, or add a one-line comment that it's reserved for future use so it doesn't read as an oversight.
- **`?name=` precedence & verbatim message injection** (`src/identity.ts:53`, `src/channel-message.ts:17`) — `?name=` takes precedence over the header (documented rationale: CC expands `${ENV}` in the URL but not headers), so the name may land in proxy logs — heed the SECURITY.md "put TLS in front" guidance. Message bodies are intentionally **not** sanitized (only length-capped at 16 KB) — that's the product; the un-spoofable `[from <name>]` tag + docs are the right mitigation.

---

## ✅ RELEASE CHECKLIST (run in order)

1. [ ] **B1** — add `rimraf` + clean step; `rm -rf dist && npm run build`; `npm pack --dry-run` shows ~36 clean files, no `mcp/`/`voiceping/`/`app.module.js`/`main.js`.
2. [ ] **B2** — push the public `kshvab/hail-mcp` repo; verify clone + homepage + issues links resolve.
3. [ ] **M1** — decide npx-runnable (a) vs clone-and-run (b); implement the chosen path; verify `npx hail-mcp` (if a).
4. [ ] **M2** — add `server.ts`/`config.ts` specs (or get explicit owner sign-off to defer).
5. [ ] **Q1–Q5** — version-read, drop `.tsbuildinfo`, fix `send()` error code, `Number.isFinite` guard, tag `v1.2.0`.
6. [ ] **Q6** — add CI; green on Node 20 & 22.
7. [ ] Docs pass (README:95/58/55/62/128 + trusted-key warning).
8. [ ] Governance: confirm PVR enabled + email fallback; CoC ladder; `.github/` templates.
9. [ ] Final gate: `npm run typecheck && npm run lint && npm test && npm pack --dry-run` all clean → `npm publish` (consider `--provenance`).

---

*Generated from a 6-dimension review (Security, Licensing, Docs, Code quality, Packaging, Community). Blockers/majors were adversarially re-verified against the actual files before inclusion; the dist blocker, repo-resolve, run-path, and test-gap findings each survived a skeptic pass.*
