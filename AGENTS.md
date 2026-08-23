# Precedent — agent notes

Write-time gate for coding agents: past review rulings are enforced at `apply_patch`
via a Codex PreToolUse hook bridged to a local daemon.

## Commands
- `bun test` — unit tests for the patch parser and ruling matcher
- `bun run daemon` — gate + live board on http://127.0.0.1:4747
- `bun run ablate -- --ruling 1` — falsification test (delete ruling → re-run → restore)
- `bun run mem:push` / `mem:pull` — sync rulings to/from the claude-mem worker

## Layout
- `src/patch.ts` — parses `apply_patch` payloads into per-file added/removed lines
- `src/match.ts` — path-scoped, decoy-resistant ruling matcher (forbid + qualified require)
- `src/db.ts` — SQLite store (`.precedent/precedent.sqlite`): rulings + decisions
- `src/daemon.ts` — `/gate`, `/rulings`, `/events` (SSE), `/ablate`, `/restore`, board at `/`
- `fixtures/repo` — the governed demo repo; its `.codex/` carries the hook
- `docs/` — website, deck, and the full build log (`docs/BUILDLOG.md`)

## Rules for changes
- The hook must always fail open; the daemon is the only place with logic.
- `require` patterns must demand qualified calls (see the decoy incident in docs/BUILDLOG.md).
- Never put the claude-mem worker on the gate's hot path.
