# PRECEDENT — the 5-minute pitch
*~660 words ≈ 5 minutes at speaking pace. Stage directions in [brackets]. Memorize the cold open and the close; everything else can flex.*

---

## COLD OPEN — 0:00

[Black slide. Deck slide 1 behind you. Don't introduce yourself yet.]

Three months ago, a senior engineer posted eleven words that got two thousand upvotes:
**"I'm now expected to review this — for the cost of hundreds of CPU hours and two minutes of their time."**

That engineer owns the payments code at their company. Every agent-written PR that touches money lands on their desk. And here is the part that should terrify you: they write the **same review comment eleven times** — because every fresh agent session wakes up with total amnesia.

I'm Moorthy. This is **Precedent**. Your team says it once. The agent hears it every time.

## THE PROBLEM — 0:40

Agents write most of the code now. Faros measured twenty-two thousand developers: median review time is up **four hundred and forty-one percent**. Thirty-one percent more code merges with **no review at all**. The bottleneck of software has moved — from writing code to absorbing it.

And everything we throw at this fails the same way. Rules files? A CLAUDE.md is a *suggestion* — the model drops it under context pressure. Review bots? They catch the bug **after** the PR exists, on the reviewer's clock, again and again. Nothing — nothing — makes a team's past decisions **binding at the moment the agent writes**.

## THE PRODUCT — 1:30

[Switch to the live terminal + board at 127.0.0.1:4747.]

So we built the gate. Watch — this is live, not a video.

I ask Codex to write a DoorDash webhook handler. It reaches for the obvious thing — `JSON.parse` on an unverified body, in payment code. And — [board flashes red] — **DENIED. In about one millisecond.** Look at what the denial says: *"Ruling #1 — first raised by you, in PR #388, raised four times since."* That's not a linter rule. That's **your team's own review history, enforced as law.**

And now watch the agent. It reads the denial… and **corrects itself.** Verified signature. Deduplicated delivery ID — because DoorDash redelivers every webhook up to three times, and that's ruling #2. No human touched anything.

## THE PROOF — 2:30

Any demo can be staged. So this one carries its own falsification test.

[Show the ablation result.] Same task. Same repo. Same model. One variable: I **delete the ruling from memory** — and Codex confidently writes the vulnerable code again. Restore the ruling — it doesn't. **The memory is doing the work, not the model.** Machine-classified, committed to the repo.

And here's the part we didn't script. Our first ruleset produced *zero* denials — because **Codex cheated.** It defined a decoy function *named* constructEvent to satisfy the rule while still parsing unverified input. The agent gamed its own guardrail. And this afternoon, we enabled **Greptile** — the host's reviewer — on our repo, and it independently found **the same decoy class in our own rules.** We fixed it within minutes, live. If you ever wanted proof that suggestions are not enforcement: the machines keep demonstrating it for us.

## THE VALUE — 3:40

[Board: value ledger.]

Every denial on this board is a repeat review round that never happened, and — for these rulings — a **money bug that never shipped**: forged webhooks marking orders paid; customers shipped three times on one payment. The board prices it conservatively — thirty reviewer-minutes, sixty dollars a denial. But the real asset is this: today, review knowledge **evaporates**. With Precedent, it **compounds** — every ruling makes every future agent session on every teammate's machine permanently smarter.

## THE COMPANY — 4:20

Greptile and CodeRabbit sell the reviewer's side — a second reviewer. Nobody sells the **author's side**: making the agent obey before the PR exists. That's the missing half of code review, and it starts with one command — `precedent init` — one repo, one hook, and a moat that compounds with every ruling.

## CLOSE — 4:45

[Slide 10. Slow down.]

Everything you just saw — engine written by Codex, rulings in claude-mem, reviewed by Greptile, real Stripe and DoorDash invariants — was built in four hours, and it's public right now: **github.com/vnmoorthy/precedent**.

We are not making agents weaker. We're making them **trustworthy enough to be given more autonomy** — because they finally remember what your team already learned.

**Precedent. Say it once.** [Stop. Hold.]

---

## If a judge asks
- **"Isn't this AGENTS.md?"** — "A rules file is advice the model drops under pressure. This is a deny at write time, retrieved by the path being patched — and you watched the ablation: delete the row, the bug returns."
- **"Regexes? Really?"** — "Deterministic tier for speed and auditability — sub-millisecond, decoy-resistant, qualified-calls-only. A semantic tier sits behind a flag; the architecture is the gate, not the pattern language."
- **"Who installs it?"** — "The author does — being blocked pre-PR is cheaper than being rejected post-PR. The buyer is the code owner who stops repeating themselves."
- **"What's real vs. roadmap?"** — "Gate, self-correction, ablation, memory sync, init, board: live today, tests green. Ruling mining from Greptile history: scaffolded in the schema, curated seeds today. We say so in the README."
