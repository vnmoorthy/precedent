/**
 * `bun run src/init.ts <path-to-repo>` — install Precedent on any repo.
 *
 * This is the product's front door: one command, and every Codex session in
 * that repo is governed by the team's rulings.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.argv[2] ?? ".");
if (!existsSync(target)) { console.error(`no such directory: ${target}`); process.exit(1); }

const here = resolve(import.meta.dir, "..");
const src = `${here}/fixtures/repo/.codex`;
const dst = `${target}/.codex`;

mkdirSync(dst, { recursive: true });
cpSync(`${src}/hooks.json`, `${dst}/hooks.json`);
cpSync(`${src}/hook.sh`, `${dst}/hook.sh`);

console.log(`
  ⚖  Precedent installed on ${target}

  hook      ${dst}/hook.sh            (fails open — a dead daemon never blocks the agent)
  daemon    bun run daemon            (from ${here})
  board     http://127.0.0.1:4747
  rulings   ${here}/fixtures/rulings.seed.json

  Every Codex session in this repo now answers to your team's rulings.
  Trust the hook once via /hooks in the Codex TUI, or use
  --dangerously-bypass-hook-trust for headless runs.
`);
