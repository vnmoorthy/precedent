/**
 * `bun run report` — the code owner's weekly receipt.
 * Read-only over the decision ledger; never touches the gate's hot path.
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const db = new Database(
  process.env.PRECEDENT_DB_PATH ??
    resolve(import.meta.dir, "../.precedent/precedent.sqlite"),
  { readonly: true },
);

const totals = db
  .query(`SELECT outcome, COUNT(*) n, ROUND(AVG(latency_ms),2) avg_ms FROM decisions GROUP BY outcome`)
  .all() as { outcome: string; n: number; avg_ms: number }[];
const byRuling = db
  .query(`SELECT d.ruling_id, r.rule, COUNT(*) n FROM decisions d
          LEFT JOIN rulings r ON r.id = d.ruling_id
          WHERE d.outcome='deny' GROUP BY d.ruling_id ORDER BY n DESC`)
  .all() as { ruling_id: number; rule: string; n: number }[];
const byPath = db
  .query(`SELECT path, COUNT(*) n FROM decisions WHERE outcome='deny' GROUP BY path ORDER BY n DESC LIMIT 5`)
  .all() as { path: string; n: number }[];

const denies = totals.find((t) => t.outcome === "deny")?.n ?? 0;
const allows = totals.find((t) => t.outcome === "allow")?.n ?? 0;

console.log(`
  PRECEDENT — audit report
  ────────────────────────────────────────────
  governed writes     ${denies + allows}
  allowed             ${allows}
  denied              ${denies}
  reviewer time est.  ${denies * 30} min reclaimed (~$${denies * 60})
  ${totals.map((t) => `avg ${t.outcome} latency   ${t.avg_ms} ms`).join("\n  ")}

  denials by ruling`);
for (const r of byRuling)
  console.log(`    #${r.ruling_id}  ×${r.n}  ${String(r.rule ?? "").slice(0, 58)}`);
console.log(`\n  hottest paths`);
for (const p of byPath) console.log(`    ×${p.n}  ${p.path}`);
console.log();
