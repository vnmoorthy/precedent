/**
 * claude-mem integration — rulings live in memory, not just SQLite.
 *
 *   bun run src/mem.ts push     # write rulings as typed observations
 *   bun run src/mem.ts pull     # read them back
 */
import { resolve } from "node:path";

const PORT = process.env.CLAUDE_MEM_PORT ?? "37777";
const MEM = `http://127.0.0.1:${PORT}`;
const PROJECT = "precedent";
const REPO_ABS = resolve(import.meta.dir, "../fixtures/repo");

type Ruling = {
  id: number; rule: string; path_glob: string;
  forbid: string[]; require: string[];
  first_pr: string; first_author: string; first_seen: string; recurrence: number;
};

async function push() {
  const rulings: Ruling[] = await Bun.file("fixtures/rulings.seed.json").json();
  const now = new Date();
  const iso = now.toISOString();
  const epoch = now.getTime();
  const sid = `precedent-rulings-${epoch}`;

  const payload = {
    sessions: [{
      content_session_id: sid, memory_session_id: sid, project: PROJECT,
      platform_source: "codex", status: "completed",
      started_at: iso, completed_at: iso,
      started_at_epoch: epoch, completed_at_epoch: epoch,
    }],
    observations: rulings.map((r) => ({
      memory_session_id: sid,
      project: PROJECT,
      type: "ruling",
      title: `Ruling #${r.id}: ${r.rule.slice(0, 70)}`,
      subtitle: `${r.first_pr} · raised ${r.recurrence}x · ${r.first_author}`,
      narrative: r.rule,
      facts: JSON.stringify([
        `forbid: ${r.forbid.join(" | ")}`,
        `require: ${r.require.join(" | ")}`,
        `scope: ${r.path_glob}`,
        `first raised: ${r.first_pr} on ${r.first_seen} by ${r.first_author}`,
        `recurrence: ${r.recurrence}`,
      ]),
      concepts: JSON.stringify(["ruling", "review-precedent", "write-time-gate"]),
      files_read: "[]",
      // BOTH relative and absolute — /api/observations/by-file is an exact json_each match
      files_modified: JSON.stringify([r.path_glob, `${REPO_ABS}/${r.path_glob}`]),
      prompt_number: 0,
      created_at: iso,
      created_at_epoch: epoch,
    })),
  };

  const res = await fetch(`${MEM}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  console.log(`POST /api/import -> ${res.status}`);
  console.log(body.slice(0, 400));
  if (!res.ok) {
    console.log("\nfalling back to /api/memory/save (type will be 'discovery')…");
    for (const r of rulings) {
      const fb = await fetch(`${MEM}/api/memory/save`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `${r.rule}\nforbid: ${r.forbid.join("|")}\nrequire: ${r.require.join("|")}\nscope: ${r.path_glob}`,
          title: `Ruling #${r.id} (${r.first_pr}, raised ${r.recurrence}x)`,
          project: PROJECT,
        }),
      });
      console.log(`  ruling #${r.id} -> ${fb.status}`);
    }
  }
}

async function pull() {
  const res = await fetch(`${MEM}/api/observations?project=${PROJECT}&limit=20`);
  const data: any = await res.json();
  const rows = Array.isArray(data) ? data : (data.items ?? data.observations ?? []);
  console.log(`${rows.length} observation(s) in project "${PROJECT}":\n`);
  for (const o of rows) {
    console.log(`  [${o.type}] ${o.title}`);
    console.log(`     ${o.subtitle ?? ""}`);
  }
}

await (process.argv[2] === "pull" ? pull() : push());
