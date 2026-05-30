## What this changes

Briefly describe the change and why.

## Checklist

- [ ] `npm run typecheck` is green
- [ ] `npm test` is green
- [ ] `npm run lint` is green
- [ ] No real keys, hosts, or private data in code, tests, or docs
- [ ] Updated README / SECURITY.md if the tool surface or security posture changed

## Wake-sensitive changes

If this PR touches the **auth gate**, the **push + keepalive path**, or the
**notification `meta`**, describe how you verified it:

- [ ] Unit test covering the change
- [ ] A live wake check against a real Claude Code session

Notes on verification:
