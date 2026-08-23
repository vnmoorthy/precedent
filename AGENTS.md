# Precedent — agent working context

**Read this file completely before writing any code.** It contains facts verified by hand on this
machine this morning. Do not re-derive them, and do not "fix" them based on your training data —
where this file contradicts what you expect, this file is right.

Event: The Fast Hackathon, Greptile @ Y Combinator SF, Sun Aug 23 2026. Hacking 1–5pm. Judging
5–5:45 (2–3 min per team). Codex must be the primary coding agent — that's you.

> **If you are resuming: jump to `CURRENT STATE & NEXT ACTIONS` at the bottom of this file first.**
> It records exactly what already exists on disk so you don't rebuild it.

---

## What we are building

**Precedent — your team's past review rulings become a hook that blocks Codex from re-writing the
code you already rejected, so the senior engineer says it once instead of eleven times.**

The loop:
1. **Mine** a repo's real review history (Greptile MCP `search_greptile_comments` + GitHub PR
   comments) into typed *rulings*: rule text, path scope, originating PR, recurrence count.
2. **Store** each ruling in claude-mem via `POST /api/import` as a typed observation.
3. **Enforce** at write time: a Codex `PreToolUse` hook on `apply_patch` looks up rulings scoped to
   the path being patched; if the patch violates one, return `permissionDecision: "deny"` with the
   ruling text and its provenance. Codex then self-corrects.
4. **Prove** it: at the moment of denial, snapshot the repo into two Modal sandboxes and run the
   test suite against both the denied patch and the corrected one, so the DENIED card carries
   *executed evidence*, not an assertion.
5. **Ablate**: delete the ruling row, re-run the identical task, watch Codex confidently write the
   bad code again. This is the money shot — it proves the memory, not the model, is doing the work.

## The one thing that must never be cut

The deny → self-correct → ablation sequence. If everything else burns, that is the demo, the memory
prize entry, and the company. Build it first and keep it working.

---

## VERIFIED FACTS — do not re-litigate

### Codex hooks (verified today on codex-cli 0.146.0, model gpt-5.6-luna)

Both mechanisms were tested end to end and **work**:

- `permissionDecision: "deny"` **blocks the command** and Codex pivots to a safe alternative on its
  own. Observed output: `ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook:
  <your reason>` followed by `hook: PreToolUse Blocked`, then Codex ran the fallback.
- `additionalContext` injected on `apply_patch` **changed Codex's diff mid-task** (it added the
  required call and the required comment marker).

Exact shapes:

```jsonc
// .codex/hooks.json  (repo-local works; global equivalent is ~/.codex/hooks.json)
{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[
  {"type":"command","command":"bash \"$PWD/.codex/hook.sh\"","timeout":10}]}]}}
```

- stdin JSON keys: `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
  `permission_mode`, `tool_name`, `tool_input`, `tool_use_id`.
- **Tool names are `Bash` and `apply_patch`** (not `Edit`/`Write`).
- For `apply_patch`, **the patch text arrives in `tool_input.command`** as a string beginning
  `*** Begin Patch` / `*** Add File: /abs/path` / `*** Update File: /abs/path`. Parse paths from
  those lines.
- For `Bash`, the command string is `tool_input.command`.
- Deny payload:
  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
   "permissionDecisionReason":"Precedent: ruling #7 ..."}}
  ```
- Context-injection payload:
  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"RAP SHEET ..."}}
  ```
- Print nothing and `exit 0` to allow. **Fail open** on any internal error — never block the agent
  because your daemon crashed.
- Keep the hook command a **static string** pointing at a script file. Codex tracks hook trust by
  hash; editing `hooks.json` re-prompts for trust, but editing the *script* does not.
- Headless runs: `codex exec --dangerously-bypass-hook-trust`. Interactive TUI: trust once via
  `/hooks`.

**Working reference implementation** (this exact script produced the verified behaviour above —
start from it):

```bash
#!/bin/bash
# .codex/hook.sh — chmod +x this. Replace the grep with a call to the rulings daemon.
IN=$(cat)
TOOL=$(printf '%s' "$IN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
CMD=$(printf '%s' "$IN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)

if [ "$TOOL" = "Bash" ] && printf '%s' "$CMD" | grep -qE '<destructive-pattern>'; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
    "permissionDecisionReason":"Precedent: ruling #7 (PR #388, 2026-07-14) — verify the signature before parsing the body."}}'
elif [ "$TOOL" = "apply_patch" ]; then
  # tool_input.command = "*** Begin Patch\n*** Add File: /abs/path\n+..."
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse",
    "additionalContext":"RULINGS for src/webhooks/: #1433 verify signature before parse; dedupe on external_delivery_id before side effects."}}'
fi
exit 0   # print nothing + exit 0 = allow. Always fail open.
```

Real captured stdin from the probe (note the key names and that the patch text is in
`tool_input.command`):

```json
{"session_id":"01a02e8e-5186-7992-a50d-6fa256bc47df","turn_id":"01a02e8e-52fd-7da2-88ef-fc70efab7f2b",
 "transcript_path":"/Users/moorthy/.codex/sessions/2026/08/23/rollout-...jsonl",
 "cwd":"/path/to/repo","hook_event_name":"PreToolUse","model":"gpt-5.6-luna",
 "permission_mode":"bypassPermissions","tool_name":"Bash",
 "tool_input":{"command":"echo danger-probe"},"tool_use_id":"exec-e8ae3f76-..."}
```

Observed tool sequence during a file-creation task — Codex reads with `Bash` before it writes with
`apply_patch`, which is why path-scoped lookup lands before the first write:

```
Bash        {"command":"ls -la && (test -d src/webhooks && ls -la src/webhooks || true)"}
apply_patch {"command":"*** Begin Patch\n*** Add File: /…/src/webhooks/drive.ts\n+export function…"}
apply_patch {"command":"*** Begin Patch\n*** Update File: /…/src/webhooks/drive.ts\n@@ …"}   ← revised after injection
```

### claude-mem 13.13.1 (local worker)

- Worker on `http://127.0.0.1:37777`. Read the port from `~/.claude-mem/settings.json`
  (`CLAUDE_MEM_WORKER_PORT`) rather than hardcoding — fresh installs default to `37700+uid%100`.
- Poll `/api/health` for `{"initialized":true}` before anything; it 503s during migrations.
- **The observer is currently STALLED** (Claude OAuth expired Jul 21; queue depth ~847). Fix with
  `claude login` then `curl -X POST 127.0.0.1:37777/api/admin/restart`. **The demo must not depend
  on live observation generation either way** — use deterministic writes only.
- **`POST /api/import`** is the only way to write *typed* rows. It accepts
  `{sessions:[...], observations:[...]}` and stores `type`, `files_modified`, `facts`, `concepts`
  verbatim, rebuilds FTS and syncs Chroma. Dedup key is `memory_session_id + title + created_at_epoch`.
- **`POST /api/memory/save`** is instant but **always stores `type: "discovery"`** — you cannot set
  a custom type through it. Use it for gate decisions, not for rulings.
- **`GET /api/observations/by-file?path=`** uses an **exact `json_each` match** — so when importing,
  write **both the repo-relative and the absolute path** into `files_modified` or lookups will miss.
- `/api/search`, `/api/timeline`, `/api/context/*` return **MCP-style markdown tables, not JSON**.
  Write one parser and reuse it. For structured JSON use `/api/observations`, `/api/observations/batch`,
  `/api/observation/:id`, `/api/summaries`, `/api/projects`, `/api/stats`.
- **Neither `/api/import` nor `/api/memory/save` broadcasts on `/stream`.** The claude-mem viewer
  shows rows only after a refresh — so build your own tiny SSE board for anything live.
- SessionStart injection is scoped by `platform_source` (Codex only sees codex-sourced rows).
  Searching without the filter crosses harnesses. This silo is a real, citable gap.
- Do **not** upgrade claude-mem today (upgrade-triggered worker restart storms are documented).
- Every hacker gets 30 days CMEM Pro (cloud sync) — `npx claude-mem install`, code `FASTHACK30` at
  cmem.ai. This is what makes the "second laptop is bound by the same ruling" beat possible.

### Greptile (the host)

- **The legacy codebase-Q&A API is GONE** — `POST /v2/query` and `/v2/search` return 404. Do not
  plan around it.
- Live surfaces: CLI `npm i -g greptile@latest` → `greptile onboard` → `greptile review --json`
  (findings + 1–5 confidence, exit codes 0 done / 3 processing / 4 failed); hosted MCP at
  `https://api.greptile.com/mcp` with `Authorization: Bearer $GREPTILE_API_KEY` (tools include
  `search_greptile_comments`, `list_merge_request_comments`, `create_custom_context`,
  `trigger_code_review`); the official Codex plugin; and the GitHub App.
- **`search_greptile_comments` is our ruling source.** Comments carry `suggestedCode`, `addressed`,
  `filePath`, line ranges.
- Reviews take **1–3 minutes**. **Never await one live on stage** — pre-run and show the result.
- 100 credits provided; 1 credit = 1 review. Enable Greptile on the submission repo.
- Unset `GREPTILE_API_KEY` while running `greptile onboard`, then set it after.

### Stripe (verified this morning)

- `stripe.webhooks.generateTestHeaderString({payload, secret[, timestamp]})` produces headers that
  `constructEvent` **accepts**. Tampered body → rejected. Wrong secret → rejected. Stale timestamp →
  rejected (**stripe-node defaults to a 300s tolerance**, so a "stale replay" only succeeds against
  an app that skips verification entirely).
- Regenerate real test-mode event fixtures in ~2 minutes (already done once and confirmed working):
  ```bash
  stripe listen --events checkout.session.completed,payment_intent.succeeded,charge.refunded \
    --print-json > fixtures/raw-events.jsonl &     # prints the whsec_ to use
  stripe trigger checkout.session.completed && stripe trigger payment_intent.succeeded \
    && stripe trigger charge.refunded
  ```
- Use this as the **machine-verifiable ruling fixture**: "verify the signature before parsing the
  body" is a ruling whose violation we can *prove* by replaying a tampered event.
- Issuing is **not** enabled on this account. Meters API works but **do not build a billing meter** —
  it reads as a checkbox to judges.

### Modal

- Not installed yet: `uv pip install modal && modal setup`, add a card, $100 credits via the form.
- Run `modal skills install` in the repo so you write current Sandbox APIs.
- `Sandbox.create` is sub-second **once the image is cached** — first image build is 1–3 min, so
  prebuild it.
- `sb.snapshot_filesystem()` returns an Image you can boot N sandboxes from — this is how the two
  evidence sandboxes stay identical.
- **Set `timeout` explicitly** (default 300s will kill a run mid-demo).
- Codex-inside-gVisor is **unverified**; if you run Codex in a sandbox use `--sandbox
  danger-full-access` and probe it early. Local git worktrees are the fallback and produce the same
  evidence bundle — say so honestly on stage if you fall back.

### AWS / DoorDash

- AWS: CLI installed, **no credentials configured**. Lambda + Function URL needs *both*
  `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` resource policies. **Lambda cannot reach
  localhost** — use SQS + a local poller if you need ingress. Skip unless a rep hands over creds.
- DoorDash: Drive sandbox is self-serve. JWT needs header `dd-ver: DD-JWT-V1`, `aud: doordash`,
  and the signing secret **base64url-decoded before signing**. Drive **retries each webhook up to
  3×**, so "dedupe on `external_delivery_id` before side effects" is a real, non-toy invariant —
  use it as the **second ruling** that fires in the demo.

---

## Build order (1–5pm) — do not reorder

| Time | Deliverable | Checkpoint |
|---|---|---|
| 1:00–1:20 | Probes only, no features. (a) `greptile review --json` on a throwaway branch; (b) Modal sandbox boot + test run, **hard 20-min timebox**; (c) hook fires in the TUI. | All three have a verdict. Modal in/out decided and never revisited. |
| 1:20–2:10 | Ruling store + the hook: parse `apply_patch` paths, look up rulings by path, deny with provenance. | A seeded ruling blocks a real Codex patch and Codex self-corrects. |
| 2:10–2:50 | Ingest real rulings from Greptile MCP + `gh` PR comments → `/api/import`. | ≥5 rulings mined from real comment history, visible by ID. |
| 2:50–3:40 | Modal evidence run: on deny, two sandboxes test denied vs corrected patch. | The DENIED card carries a real test result. |
| 3:40–4:10 | Ablation + board: delete ruling → re-run → regression. Tiny SSE page. | Ablation runs clean twice in a row. |
| 4:10–4:30 | **Feature freeze.** Record backup video. Re-trust hooks. | Backup video exists, one keypress away. |
| 4:30–5:00 | Rehearse twice with a stopwatch. Stage tabs. | Under 100 seconds, twice. |

**2:10 is the hard gate.** If the hook isn't denying and self-correcting by then, cut Modal, cut the
miner, cut the board — everyone on the hook until it works.

## Demo order (90 seconds)

1. **0:00–0:20** — the mined number: "I mined this repo's review history; eleven objections were
   made more than once. Here they are."
2. **0:20–1:00** — live: Codex told to add a webhook handler starts writing a naive HMAC compare
   with no timestamp check → **DENIED**, citing ruling #7 from PR #388 → Codex self-corrects →
   Modal shows the denied version failing the tampered-signature test.
3. **1:00–1:20** — **delete the ruling row, re-run the identical task, Codex writes the bad code
   again.** The proof.
4. **1:20–1:30** — CMEM Pro sync: a second machine's agent is bound by the same ruling. Then the ask.

## Framing rules (non-negotiable)

- You are demoing an enforcement layer that restrains OpenAI's agent **in front of OpenAI**. Frame it
  every single time as *making Codex trustworthy enough to grant more autonomy* — never as
  restraining an agent that misbehaves.
- Never pitch "we save you Greptile credits" to Greptile. Greptile is the *source of rulings* and the
  independent validator; Precedent acts pre-write, they act post-PR. Complementary, not competing.
- Do not claim the underlying pain was "verified" — it was not, at the strict bar. Lead with the
  mined number from real data instead.
- Rehearsed answer to *"Isn't this AGENTS.md / a lint rule / Cursor rules?"*:
  **"A rules file is a suggestion the model drops under context pressure. This is a deny at write
  time, retrieved by the path being patched — and here's the run where I deleted the row and it
  regressed."**

## Pitfalls that will eat your clock

- Hardcoding port 37777 instead of reading settings.
- Forgetting relative **and** absolute paths in `files_modified` → `by-file` returns empty.
- Using `/api/memory/save` for rulings (it forces `type: "discovery"`).
- Expecting JSON from `/api/search` (it's markdown).
- Awaiting a Greptile review during the demo.
- Modal's 300s default timeout.
- Editing `hooks.json` late and hitting a fresh trust prompt mid-rehearsal.
- Building a billing meter, a generic dashboard, or anything that isn't the deny→correct→ablate loop.

## House style

TypeScript + Bun, SQLite, small composable CLI commands. Keep the hook script dependency-free bash +
one `curl` to a local daemon with a 1.5s timeout. Prefer boring, inspectable code — judges will look
at the screen, not the architecture.

---
---

# IMPLEMENTATION PLAN — the whole product

Everything below is the complete build. Follow the component order; each has an acceptance test you
must actually run before moving on.

## Repo layout

```
precedent/
  package.json                 # bun, type: module
  .codex/
    hooks.json                 # PreToolUse -> hook.sh  (static command string!)
    hook.sh                    # dependency-free bash, curl -> daemon, fail-open
  src/
    cli.ts                     # entry: precedent <mine|compile|serve|enforce|prove|ablate|report>
    db.ts                      # SQLite: rulings, decisions, evidence
    rulings.ts                 # Ruling type, CRUD, path-scope matching
    match.ts                   # THE CORE: does this patch violate this ruling?
    patch.ts                   # parse apply_patch payload -> {path, addedLines, removedLines}[]
    mine/
      greptile.ts              # MCP search_greptile_comments -> raw objections
      github.ts                # gh api PR review comments -> raw objections
      distill.ts               # raw objections -> Ruling[] via codex exec --json + schema
    mem/
      client.ts                # claude-mem: import(), search(), byFile(), save()
      shapes.ts                # exact /api/import payload builders
    daemon.ts                  # Bun.serve: POST /gate, GET /events (SSE), GET /rulings
    prove/
      modal_evidence.py        # two sandboxes: denied patch vs corrected patch -> test results
      local_evidence.ts        # git-worktree fallback, identical output shape
    board/
      index.html               # single file, SSE, no build step
  fixtures/
    repo/                      # the demo target repo (see "Fixture repo")
    rulings.seed.json          # pre-mined rulings, cached in prep
  test/
    match.test.ts              # bun test — the only unit tests that matter
```

## Data model

```ts
type Ruling = {
  id: number;
  rule: string;              // human sentence shown in the deny reason
  path_glob: string;         // "src/webhooks/**", "**/*.ts"
  // --- the compiled predicate (Tier 1, deterministic) ---
  forbid: string[];          // regexes: if an ADDED line matches any -> candidate violation
  require: string[];         // regexes: must appear somewhere in the patched file's new content
  // --- provenance, shown on the card ---
  first_pr: string;          // "#388"
  first_author: string;      // "@you"
  first_seen: string;        // ISO date
  recurrence: number;        // how many times this objection was made
  source: 'greptile' | 'github' | 'seed';
  source_url?: string;
  mem_observation_id?: number; // set after /api/import
};

type Decision = {
  id: number; ts: string; session_id: string; tool: 'apply_patch' | 'Bash';
  path: string; ruling_id: number | null;
  outcome: 'allow' | 'deny'; latency_ms: number; reason?: string;
};
```

SQLite is the hot path (the hook must answer in <100ms). claude-mem is the **source of truth and
the shareable artifact** — rulings are written there via `/api/import` and re-read on daemon boot.
Never put claude-mem on the hook's critical path.

## Component 1 — patch parsing (`patch.ts`)

`apply_patch` arrives as one string in `tool_input.command`:

```
*** Begin Patch
*** Add File: /abs/path/src/webhooks/drive.ts
+export function handleDriveWebhook(event) {
*** Update File: /abs/path/src/webhooks/stripe.ts
@@
-const e = JSON.parse(req.body)
+const e = stripe.webhooks.constructEvent(req.body, sig, secret)
*** End Patch
```

```ts
export function parsePatch(command: string): PatchedFile[]
// PatchedFile = { path: string; relPath: string; added: string[]; removed: string[] }
```
Rules: strip the repo root to get `relPath` (match rulings on BOTH). `+`-prefixed lines are `added`,
`-`-prefixed are `removed`. Ignore `@@` hunk headers and the `*** ` directives themselves.

**Acceptance:** `bun test test/match.test.ts` parses the three-file example above into 2 files with
the right added/removed line counts.

## Component 2 — the matcher (`match.ts`) — THE CORE

This is the piece that decides whether to block, so it is the piece most likely to embarrass you on
stage. Two tiers; **the demo runs on Tier 1**.

**Tier 1 — deterministic predicate (default, <5ms, no network).**
A ruling violates iff:
1. `path_glob` matches the patched file's `relPath`, AND
2. some ADDED line matches any `forbid` regex, AND
3. none of the `require` regexes appear in the file's resulting content.

Condition 3 is what stops false positives: writing `JSON.parse(req.body)` is only a violation if the
file does **not** also verify the signature.

```ts
export function evaluate(file: PatchedFile, rulings: Ruling[]): Violation | null
// Violation = { ruling: Ruling; line: string; lineNo: number }
```

**Tier 2 — semantic fallback (flag-gated, OFF during the demo).**
`codex exec --json -m gpt-5.6-luna` with an output schema `{violates: boolean, reason: string}`,
hard 4s timeout, fail-open on timeout. Use it only for rulings whose `forbid` compilation was
low-confidence. Mention it on stage as the general path; do not depend on it live.

**Acceptance:** `bun test` with at least these cases green —
- naive `JSON.parse(req.body)` in `src/webhooks/*` with no `constructEvent` → **violation**
- same file WITH `constructEvent` present → **no violation** (this is the false-positive guard)
- `JSON.parse` in `src/utils/*` → **no violation** (path scope works)
- a patch touching a file with zero matching rulings → **no violation**, and the whole call returns
  in <5ms

## Component 3 — the hook (`.codex/hook.sh`)

```bash
#!/bin/bash
IN=$(cat)
RESP=$(printf '%s' "$IN" | curl -s -m 1.5 -X POST 127.0.0.1:4747/gate \
        -H 'content-type: application/json' --data-binary @- 2>/dev/null)
[ -n "$RESP" ] && printf '%s' "$RESP"
exit 0
```
That is the whole hook. All logic lives in the daemon so you can edit it without touching the trust
hash. **Fail open**: no daemon, no output, agent proceeds.

**Acceptance:** with the daemon down, a Codex task completes normally. With it up and a seeded
ruling, the same task is denied. Run both.

## Component 4 — the daemon (`daemon.ts`)

```
POST /gate      <- hook stdin JSON, -> {} | {hookSpecificOutput:{...deny}}
GET  /events    <- SSE stream of Decision rows for the board
GET  /rulings   <- current ruling ledger as JSON
POST /ablate    <- {ruling_id} : soft-delete a ruling (for the demo beat), returns the row
POST /restore   <- {ruling_id} : undo, so you can rehearse repeatedly
```
`/gate` logic: `parsePatch` → load rulings for those paths from SQLite → `evaluate` → on violation
build the deny payload, insert a `Decision`, broadcast on SSE, and (async, never awaited) POST the
decision to claude-mem `/api/memory/save`.

Deny reason format — provenance is what makes it land:
```
Precedent: ruling #7 — "Verify the webhook signature before parsing the body."
First raised by @you in PR #388 on 2026-07-14. Raised 4 times since.
Your patch adds `JSON.parse(req.body)` at src/webhooks/drive.ts:12 with no constructEvent call.
```

**Acceptance:** `curl -X POST :4747/gate --data-binary @fixtures/sample-hook-stdin.json` returns a
deny payload in <100ms (`time` it).

## Component 5 — the miner (`mine/`)

Run this in **prep**, cache to `fixtures/rulings.seed.json`, and present it as a pre-baked chart.
It is the most fragile and least demoable component — keep it off the 1–5pm critical path.

- `greptile.ts`: POST to `https://api.greptile.com/mcp` (`Authorization: Bearer $GREPTILE_API_KEY`),
  call `search_greptile_comments`, collect `{body, filePath, suggestedCode, prNumber, addressed}`.
- `github.ts`: `gh api "repos/{owner}/{repo}/pulls/comments?per_page=100"` — the review comments
  endpoint, paginated. Group by normalized body text to find repeats.
- `distill.ts`: cluster near-duplicate objections, then one `codex exec --json` call with an output
  schema producing `Ruling[]` — specifically asking for `forbid`/`require` regexes and a `path_glob`.
  **Validate every generated regex compiles** before storing; drop any that doesn't.

**The mined number for the pitch:** count objections raised ≥2 times. That sentence — *"I mined this
repo's review history; eleven objections were made more than once"* — is your opening line.

## Component 6 — claude-mem integration (`mem/`)

Write rulings with `/api/import` (the ONLY path that stores a custom type):

```ts
{
  sessions: [{
    content_session_id: `precedent-mine-${Date.now()}`,
    memory_session_id:  `precedent-mine-${Date.now()}`,
    project: repoName, platform_source: 'codex', status: 'completed',
    started_at: iso, completed_at: iso,
    started_at_epoch: ms, completed_at_epoch: ms,
  }],
  observations: rulings.map(r => ({
    memory_session_id: sessionId, project: repoName,
    type: 'ruling',                                  // custom type — only /api/import allows this
    title: `Ruling #${r.id}: ${r.rule.slice(0,60)}`,
    subtitle: `${r.first_pr} · raised ${r.recurrence}x`,
    narrative: r.rule,
    facts:    JSON.stringify([`forbid: ${r.forbid.join('|')}`, `require: ${r.require.join('|')}`,
                              `scope: ${r.path_glob}`, `source: ${r.source_url ?? r.source}`]),
    concepts: JSON.stringify(['ruling','review-precedent']),
    files_read: '[]',
    files_modified: JSON.stringify([r.path_glob, absGlob]),  // BOTH relative and absolute
    prompt_number: 0, created_at: iso, created_at_epoch: ms,
  })),
}
```

Reads: `/api/observations?project=X&limit=500` filtered to `type === 'ruling'` on boot, refreshed
every 10s. Parse `facts` back into the predicate. `by-file` lookups need the exact stored path — this
is why you store both forms.

**Acceptance:** import one ruling, then `GET /api/observations?project=X` returns it with
`type: "ruling"` intact. If `/api/import` rejects your payload, fall back to `/api/memory/save`
(accepting `type: "discovery"`) and put the predicate in the title — do not lose the demo to schema
archaeology.

## Component 7 — the evidence run (`prove/`) — raises Technical from 6 to 8

On deny, produce **executed proof** the ruling was right:

```python
# modal_evidence.py
img = modal.Image.debian_slim().apt_install("git").run_commands("npm i -g bun")
sb = modal.Sandbox.create(app=app, image=img, timeout=900)     # SET THE TIMEOUT
# clone repo at HEAD, install deps once, then:
snap = sb.snapshot_filesystem()
# boot TWO sandboxes from the identical snapshot:
#   A: apply the DENIED patch      -> run the repo's tests -> expect FAIL
#   B: apply the CORRECTED patch   -> run the repo's tests -> expect PASS
```
Return `{denied: {passed, failed, output}, corrected: {passed, failed, output}}` and render it onto
the DENIED card: *"the version you were about to write fails `webhook.tampered-signature.test.ts`."*

`local_evidence.ts` is the fallback: two `git worktree` copies, same output shape. **Decide by 1:20
which one you're using and never revisit it.**

**Acceptance:** the denied patch's test run is red and the corrected one is green, both captured to
JSON, in under 90 seconds total.

## Component 8 — the ablation (`ablate`)

```bash
precedent ablate --ruling 7     # soft-delete, re-run the task, capture that Codex writes the bad code
precedent restore --ruling 7    # so you can rehearse this repeatedly
```
Runs `codex exec --json` on the identical seeded task with the ruling absent, captures the resulting
patch, and diffs it against the with-ruling run. **This is the single most important 15 seconds of
the demo — build it before the board.**

**Acceptance:** run it three times in a row; the bad code must reappear all three times. If it's
flaky, make the seeded task more constrained until it isn't.

## Component 9 — the board (`board/index.html`)

One static file, no build step, `EventSource('/events')`. Shows: the ruling ledger with recurrence
counts, live decision cards (green allow / red deny with provenance + latency), and the evidence
panel. Cut this before you cut anything else — a terminal is an acceptable demo surface.

## The five seed rulings (for the fixture repo)

| # | Rule | Scope | forbid | require |
|---|---|---|---|---|
| 1 | Verify the webhook signature before parsing the body | `src/webhooks/**` | `JSON\.parse\(\s*req\.(body\|rawBody)` | `constructEvent` |
| 2 | Dedupe on `external_delivery_id` before side effects (Drive retries 3×) | `src/webhooks/doordash*` | `await\s+(fulfill\|ship\|send)` | `external_delivery_id` |
| 3 | Never log request bodies on payment paths | `src/(webhooks\|payments)/**` | `console\.log\([^)]*\b(body\|payload\|event)\b` | — |
| 4 | Money must be integer cents, never float | `src/payments/**` | `parseFloat\([^)]*amount` | — |
| 5 | No `any` on exported API types | `src/api/**` | `export .*:\s*any\b` | — |

Rulings 1 and 2 are the demo. 1 is machine-verifiable via the Stripe fixture (replay a tampered
event → a correct handler 400s, the denied version accepts it). 2 is a real DoorDash Drive invariant,
not a toy.

## Fixture repo (`fixtures/repo/`) — build in prep

Node + TypeScript + Bun, a small orders service with `src/webhooks/stripe.ts` (correct, with
`constructEvent`), `src/webhooks/doordash.ts` **absent** (this is what Codex will be told to write),
`src/payments/`, and a real `bun test` suite including `webhook.tampered-signature.test.ts` which
replays a re-signed bad payload. **`AGENTS.md` in that fixture must be empty of guard rules** — the
contrast has to be attributable to Precedent, not to instructions.

The seeded demo task, rehearsed verbatim:
> "Add a DoorDash Drive webhook handler at src/webhooks/doordash.ts that marks the order fulfilled."

Codex will reach for `JSON.parse(req.body)` and call `fulfill()` without deduping — tripping rulings
1 and 2. Rehearse this exact prompt at least twice; if Codex writes it correctly by luck, tighten the
fixture (e.g. remove any nearby correct example it could copy).

## Prep checklist (before 1pm — setup only, no product code)

- [ ] `claude login`; `curl -X POST 127.0.0.1:37777/api/admin/restart`; confirm `/api/health` shows `initialized: true`
- [ ] Greptile: signup, API key, `npm i -g greptile@latest`, install the GitHub App on the demo repo
- [ ] Mine rulings → `fixtures/rulings.seed.json` (cache it; do not re-mine live)
- [ ] `uv pip install modal && modal setup`, add card, `modal skills install`, **prebuild the image**
- [ ] Build + push `fixtures/repo/` with the real test suite; AGENTS.md left empty of guards
- [ ] Redeem the $100 Codex credit link (personal ChatGPT workspace only)
- [ ] `npx claude-mem install`, `FASTHACK30` at cmem.ai for CMEM Pro cloud sync
- [ ] Rehearse the seeded task once to confirm Codex writes the bad code unaided

## Definition of done, in priority order

1. A seeded ruling denies a real Codex patch and Codex self-corrects. ← **without this there is no demo**
2. The ablation makes the bad code come back, reproducibly, three times running.
3. Rulings were mined from real review history, with the ≥2× recurrence number on screen.
4. The DENIED card carries an executed test result from a sandbox.
5. A second machine, via CMEM Pro sync, is bound by the same ruling.
6. The board renders it all live.

Ship 1–2 by 2:10 or cut everything else until you have them.

---
---

# CURRENT STATE & NEXT ACTIONS

Verified on disk at 14:45 by inspection, not assumed. Trust this over your own memory of the session.

## What already exists — do NOT rebuild

- **git repo**, one commit `c7d4ca4 chore: establish probe baseline` (that commit contains only
  AGENTS.md).
- **`.codex/hooks.json`** — matcher is currently `"Bash"` **only**. ⚠️ Must be widened, see step 0.
- **`.codex/hook.sh`** — probe-only: denies a shell command containing the marker
  `precedent-hook-probe`, fails open otherwise. It proved the mechanism. It is **not** the product
  hook yet; it must be replaced with the daemon-calling version in step 4.
- **claude-mem worker** is up and healthy (`/api/health` → `initialized: true`), queue draining
  (depth 11, was 847). Note: newest observation is still dated 2026-07-21, so the observer has not
  emitted anything new — **as planned, do not depend on live observation generation.**

## What does NOT exist yet

No `package.json`, no `src/`, no `fixtures/`, no `test/`, no daemon. Nothing on port 4747.
`modal` is **not installed** and there is no `~/.modal.toml`.
`GREPTILE_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY` are all **unset**.

Toolchain present and versioned: bun 1.3.11 · node v24.14.1 · python3 3.12.4 · uv 0.12.5 ·
greptile 3.4.1 · gh 2.91.0 · stripe 1.45.0 · codex 0.146.0 · claude 2.1.207.

## Step 0 — widen the hook matcher (2 min, do this first)

The current matcher only fires on `Bash`. The product enforces on **`apply_patch`**. Rewrite
`.codex/hooks.json` to:

```json
{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[
  {"type":"command","command":"bash \"$PWD/.codex/hook.sh\"","timeout":10}]}]}}
```
Editing `hooks.json` invalidates the trust hash → re-trust once via `/hooks` in the TUI. **Do this
now, not at 4pm.** After this, never edit `hooks.json` again — only `hook.sh`.

**Verify:** run a Codex task that creates a file; confirm the hook receives a `tool_name` of
`apply_patch` (log stdin to `/tmp/precedent-hook.log` temporarily to see it).

## Step 1 — bootstrap (5 min)

```bash
bun init -y
bun add -d @types/bun
mkdir -p src/{mine,mem,prove,board} test fixtures/repo
```
Add to `package.json`: `"type":"module"`, and scripts `dev`, `test`, `daemon`.

**Verify:** `bun test` runs (0 tests is fine) and `bun --version` works from the repo root.

## Step 2 — `src/patch.ts` + `src/match.ts` + tests (25 min) — BUILD THIS BEFORE ANYTHING ELSE

These two files are the product. Write them with tests first; they are pure functions with no I/O,
so they are fast to get right and they are what everything else depends on.

**Verify (must pass before you continue):**
```bash
bun test test/match.test.ts
```
with the four cases named in Component 2 green — especially the false-positive guard (a webhook file
that *does* call `constructEvent` must NOT be flagged).

## Step 3 — `src/db.ts` + seed rulings (15 min)

SQLite via `bun:sqlite`. Create `rulings` and `decisions` tables. Load the five seed rulings from
the table in "The five seed rulings" into `fixtures/rulings.seed.json` and insert them.

**Verify:** `bun run src/cli.ts rulings` prints 5 rulings with their globs and regexes.

## Step 4 — `src/daemon.ts` + real `hook.sh` (30 min)

Daemon on 4747 with `/gate`, `/events`, `/rulings`, `/ablate`, `/restore`. Then replace
`.codex/hook.sh` with the 6-line curl version from Component 3 (keep the filename identical so the
trust hash survives).

**Verify — this is the 2:10 hard gate:**
```bash
# 1. daemon answers fast
time curl -s -X POST 127.0.0.1:4747/gate --data-binary @fixtures/sample-hook-stdin.json
# 2. end to end, the real thing:
codex exec --dangerously-bypass-hook-trust -C fixtures/repo \
  "Add a DoorDash Drive webhook handler at src/webhooks/doordash.ts that marks the order fulfilled."
```
Expected: Codex is **denied**, prints the ruling text with provenance, and self-corrects. If this
does not happen, stop everything else and fix it — nothing downstream matters without it.

## Step 5 — `src/mem/` claude-mem integration (25 min)

`client.ts` + `shapes.ts` per Component 6. Import the 5 rulings, then read them back on daemon boot.

**Verify:**
```bash
bun run src/cli.ts mem-push && \
curl -s "127.0.0.1:37777/api/observations?project=precedent&limit=10" | python3 -m json.tool | head -40
```
Expect `"type": "ruling"` preserved. If `/api/import` rejects the payload, fall back to
`/api/memory/save` (accepting `type: "discovery"`, predicate in the title) — **do not lose 30
minutes to schema archaeology.**

## Step 6 — `ablate` (20 min) — build this BEFORE the evidence run

```bash
bun run src/cli.ts ablate --ruling 1
```
Soft-deletes the ruling, re-runs the identical seeded task via `codex exec --json`, captures the
resulting patch, restores the ruling.

**Verify:** run it **three times**; the bad code (`JSON.parse(req.body)` with no `constructEvent`)
must come back all three. Flaky? Tighten the fixture until it isn't. This is the most important 15
seconds of your demo.

## Step 7 — fixture repo (30 min, can run in parallel with 5–6)

Build `fixtures/repo/` per the "Fixture repo" section: correct `src/webhooks/stripe.ts`, **absent**
`src/webhooks/doordash.ts`, a real `bun test` suite including `webhook.tampered-signature.test.ts`,
and an **empty-of-guards** `AGENTS.md`.

**Verify:** `cd fixtures/repo && bun test` is green before Precedent touches anything.

## Step 8 — evidence run (35 min) — the Technical-score lifter

```bash
uv pip install modal && modal setup        # + add a card, $100 credits via the form
modal skills install                        # so you write current Sandbox APIs
```
Then `src/prove/modal_evidence.py` per Component 7. **Set `timeout` explicitly.** If Modal is not
working within 20 minutes, switch to `src/prove/local_evidence.ts` (git worktrees, identical output
shape) and say so honestly on stage.

**Verify:** denied patch → tests red; corrected patch → tests green; both captured to JSON in <90s.

## Step 9 — board + polish (25 min)

`board/index.html`, single file, `EventSource('/events')`. Cut this before cutting anything else.

## Step 10 — freeze at 4:10

Stop writing code. Record the backup video of deny → self-correct → ablation. Re-trust hooks if
`hooks.json` changed. Rehearse twice with a stopwatch, under 100 seconds.

---

## Setup that needs a human (do these at check-in, they block steps 5 and 8)

- [ ] Redeem the **$100 Codex credit** link (personal ChatGPT workspace only, expires Aug 25)
- [ ] **Greptile**: sign up, get API key, `export GREPTILE_API_KEY=...`, install the GitHub App on the
      demo repo, enable it. Unset the key while running `greptile onboard`, set it after.
- [ ] **Modal**: fillout form for $100, then `modal setup`
- [ ] **CMEM Pro**: `npx claude-mem install`, code `FASTHACK30` at cmem.ai (needed for the
      second-machine sync beat)

## Do NOT do these

- Do not rebuild the probe hook — it already proved the mechanism; replace it in step 4.
- Do not edit `hooks.json` after step 0.
- Do not build a Stripe billing meter, a generic cost dashboard, or a settings UI.
- Do not put claude-mem on the hook's critical path (SQLite is the hot path).
- Do not await a Greptile review during the demo.
- Do not re-mine rulings live — use the cached `fixtures/rulings.seed.json`.
- Do not start step 8 or 9 until step 4's end-to-end verification has passed.

## Order of sacrifice if you fall behind

Board → evidence run → second-machine sync → real mining (use seeds) → **never** the deny +
self-correct + ablation loop.

---
---

# ⏱ T-MINUS TRIAGE — written 15:05, 115 minutes left

**This supersedes the 11-step plan above.** Steps 0, 1, 2 are DONE and verified (`bun test` → 8 pass,
0 fail). The full plan no longer fits. Build in exactly this order and stop when the clock says stop.

## CUT — do not start these

- ❌ **Modal evidence run.** Modal is not even installed; install + image build + debug is 30+ min
  and it is not the core. If you are green and idle at 16:10, do `src/prove/local_evidence.ts`
  (two `git worktree` copies, same output shape) instead and say "Modal is the scale path" on stage.
- ❌ **Live Greptile mining.** Use hand-written seed rulings. Mining is a prep-time luxury.
- ❌ Second-machine CMEM Pro sync, the `/api/search` markdown parser, Tier-2 semantic matching.

## 15:05–15:35 · THE GATE (30 min) — nothing else matters until this works

1. `src/db.ts` — `bun:sqlite`, tables `rulings` + `decisions`, load `fixtures/rulings.seed.json`.
   Seed **only rulings 1 and 2** from the seed table (signature-before-parse, dedupe-before-fulfill).
2. `src/daemon.ts` — `Bun.serve` on 4747: `POST /gate`, `GET /rulings`, `GET /events` (SSE),
   `POST /ablate`, `POST /restore`. `/gate` = `parsePatch` → load rulings by path → `evaluate` →
   deny payload + insert Decision + SSE broadcast.
3. **Replace `.codex/hook.sh`** (keep the filename — the trust hash is on `hooks.json`, which is
   already correct at `.*`, so do NOT touch `hooks.json` again):
   ```bash
   #!/bin/bash
   IN=$(cat)
   RESP=$(printf '%s' "$IN" | curl -s -m 1.5 -X POST 127.0.0.1:4747/gate \
           -H 'content-type: application/json' --data-binary @- 2>/dev/null)
   [ -n "$RESP" ] && printf '%s' "$RESP"
   exit 0
   ```

**GATE CHECK — run this, paste the output, do not proceed until it denies:**
```bash
bun run src/daemon.ts &            # leave it running
sleep 1 && curl -s 127.0.0.1:4747/rulings | head -5
mkdir -p /tmp/fix/src/webhooks && cd /tmp/fix && git init -q 2>/dev/null
codex exec --dangerously-bypass-hook-trust -C /tmp/fix \
  "Create src/webhooks/doordash.ts with a handler that parses the request body with JSON.parse(req.body) and calls fulfill(order)."
```
Expected: **denied**, ruling text with provenance visible, Codex self-corrects.
If it does not deny by **15:40**, stop building and debug only this.

## 15:35–15:55 · FIXTURE + ABLATION (20 min) — the money shot

4. `fixtures/repo/` — minimal: `src/webhooks/stripe.ts` (correct, calls `constructEvent`),
   **no** `doordash.ts`, one passing `bun test`, and an `AGENTS.md` that is **empty of guard rules**.
5. `src/cli.ts ablate --ruling 1` — soft-delete the ruling, re-run the identical seeded task via
   `codex exec --json`, capture the patch, restore the ruling.

**CHECK:** run `ablate` **three times**. The bad code must come back all three. If flaky, constrain
the seeded prompt until it is not. This is the 15 seconds that wins the memory prize.

## 15:55–16:15 · MEMORY PRIZE (20 min)

6. `src/mem/client.ts` — push the rulings to claude-mem via `POST /api/import` with
   `type: "ruling"` and **both** relative + absolute paths in `files_modified`.
   Worker is confirmed healthy (`initialized: true`).
   **CHECK:** `curl -s "127.0.0.1:37777/api/observations?project=precedent&limit=5" | python3 -m json.tool`
   shows `"type": "ruling"`. If `/api/import` rejects the payload, immediately fall back to
   `/api/memory/save` and move on — **do not spend more than 10 minutes here.**
7. Daemon reads rulings from claude-mem on boot (falls back to SQLite). Now "delete the memory row"
   in the ablation is literally deleting memory — which is the pitch.

## 16:15–16:35 · BOARD (20 min, first thing to cut)

8. `src/board/index.html`, one file, `EventSource('/events')`: ruling ledger + live deny cards with
   provenance and latency. A terminal is an acceptable fallback surface.

## 16:35–17:00 · FREEZE

9. **Stop writing code at 16:35.** `git add -A && git commit` (nothing is committed since
   `c7d4ca4` — do this now, not at 16:55).
10. Record a screen capture of: deny → self-correct → ablation → bad code returns.
11. Rehearse twice with a stopwatch. Target under 100 seconds.

## Demo, compressed to what will exist

1. "I have two rulings from this repo's review history." (show the ledger)
2. Live: Codex told to add the DoorDash webhook → **DENIED** with ruling + provenance → self-corrects.
3. **Delete the ruling from memory, re-run, the bad code comes back.**
4. "Memory that enforces, not memory that suggests. `npx precedent init`."

## Commit discipline

You have written ~240 lines and committed none of them. Commit after every green check:
`git add -A && git commit -m "..."`. A demo that dies at 16:50 with uncommitted work is unrecoverable.
