# Precedent — agent working context

**Read this file completely before writing any code.** It contains facts verified by hand on this
machine this morning. Do not re-derive them, and do not "fix" them based on your training data —
where this file contradicts what you expect, this file is right.

Event: The Fast Hackathon, Greptile @ Y Combinator SF, Sun Aug 23 2026. Hacking 1–5pm. Judging
5–5:45 (2–3 min per team). Codex must be the primary coding agent — that's you.

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
