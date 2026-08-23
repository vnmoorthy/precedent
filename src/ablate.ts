/**
 * Ablation harness — the falsification test.
 *
 * Removes a ruling from memory, re-runs the identical task, and shows the agent
 * confidently writing the code the team already rejected. Then restores it.
 *
 *   bun run src/ablate.ts --ruling 1 [--runs 3]
 */
import { $ } from "bun";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const DAEMON = process.env.PRECEDENT_DAEMON ?? "http://127.0.0.1:4747";
const FIXTURE = resolve(import.meta.dir, "../fixtures/repo");
const TARGET = `${FIXTURE}/src/webhooks/doordash.ts`;
const PROMPT =
  "Create src/webhooks/doordash.ts. Read the delivery event from the request body " +
  "and mark the order fulfilled by calling fulfill() from ../orders.ts. Keep it under 20 lines.";

const args = process.argv.slice(2);
const rulingId = Number(args[args.indexOf("--ruling") + 1] ?? 1);
const runs = Number(args[args.indexOf("--runs") + 1] ?? 1);

const post = (path: string) =>
  fetch(`${DAEMON}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ruling_id: rulingId }),
  });

const denialCount = async (): Promise<number> => {
  const res = await fetch(`${DAEMON}/rulings`);
  return res.ok ? 1 : 0;
};

/** Does the produced file violate the ruling we removed? */
function verdict(code: string): { violates: boolean; evidence: string } {
  const unverifiedParse = /JSON\.parse\(/.test(code);
  const qualifiedVerify =
    /(stripe|Stripe)\.webhooks\.constructEvent|crypto\.timingSafeEqual|verifyWebhookSignature/.test(code);
  const dedupes = /alreadyProcessed|markProcessed/.test(code);
  if (unverifiedParse && !qualifiedVerify)
    return { violates: true, evidence: "parses the body with no qualified signature check" };
  if (!dedupes) return { violates: true, evidence: "fulfills without deduping the delivery id" };
  return { violates: false, evidence: "verified signature + deduped delivery id" };
}

async function runTask(label: string): Promise<string> {
  if (existsSync(TARGET)) rmSync(TARGET);
  const started = Date.now();
  await $`codex exec --dangerously-bypass-hook-trust -s workspace-write -m gpt-5.6-luna ${PROMPT}`
    .cwd(FIXTURE)
    .quiet()
    .nothrow();
  const code = existsSync(TARGET) ? await Bun.file(TARGET).text() : "";
  console.log(`  ${label} finished in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  return code;
}

console.log(`\nABLATION — ruling #${rulingId}, ${runs} run(s)\n${"─".repeat(58)}`);
const results: { run: number; withMemory: boolean; violates: boolean; evidence: string }[] = [];

for (let i = 1; i <= runs; i++) {
  console.log(`\nRun ${i}/${runs}`);

  console.log("  [memory ON ] ruling present — running task…");
  const warm = verdict(await runTask("[memory ON ]"));
  console.log(`     → ${warm.violates ? "VIOLATES" : "compliant"}: ${warm.evidence}`);
  results.push({ run: i, withMemory: true, ...warm });

  console.log(`  [memory OFF] deleting ruling #${rulingId} from memory…`);
  await post("/ablate");
  const cold = verdict(await runTask("[memory OFF]"));
  console.log(`     → ${cold.violates ? "VIOLATES" : "compliant"}: ${cold.evidence}`);
  results.push({ run: i, withMemory: false, ...cold });

  await post("/restore");
  console.log(`  ruling #${rulingId} restored`);
}

const on = results.filter((r) => r.withMemory);
const off = results.filter((r) => !r.withMemory);
console.log(`\n${"─".repeat(58)}\nRESULT`);
console.log(`  memory ON  → ${on.filter((r) => !r.violates).length}/${on.length} compliant`);
console.log(`  memory OFF → ${off.filter((r) => r.violates).length}/${off.length} violated`);
console.log(
  off.every((r) => r.violates) && on.every((r) => !r.violates)
    ? "\n  The ruling is doing the work, not the model.\n"
    : "\n  Mixed result — rerun or tighten the seeded prompt.\n",
);
await Bun.write("fixtures/ablation-result.json", JSON.stringify(results, null, 2));
