import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { matchesPathGlob, type Ruling } from "./match.ts";

export type StoredRuling = Ruling & {
  active: boolean;
  ablated_at: string | null;
};

export type Decision = {
  id: number;
  ts: string;
  session_id: string;
  tool: "apply_patch" | "Bash";
  path: string;
  ruling_id: number | null;
  outcome: "allow" | "deny";
  latency_ms: number;
  reason?: string;
};

type RulingRow = {
  id: number;
  rule: string;
  path_glob: string;
  forbid_json: string;
  require_json: string;
  first_pr: string;
  first_author: string;
  first_seen: string;
  recurrence: number;
  source: Ruling["source"];
  source_url: string | null;
  mem_observation_id: number | null;
  active: number;
  ablated_at: string | null;
};

type StoreOptions = {
  dbPath?: string;
  seedPath?: string;
};

const DEFAULT_DB_PATH = resolve(
  import.meta.dir,
  "../.precedent/precedent.sqlite",
);
const DEFAULT_SEED_PATH = resolve(
  import.meta.dir,
  "../fixtures/rulings.seed.json",
);

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new TypeError("Expected a JSON array of strings in the ruling store");
  }
  return parsed;
}

function toStoredRuling(row: RulingRow): StoredRuling {
  return {
    id: row.id,
    rule: row.rule,
    path_glob: row.path_glob,
    forbid: parseStringArray(row.forbid_json),
    require: parseStringArray(row.require_json),
    first_pr: row.first_pr,
    first_author: row.first_author,
    first_seen: row.first_seen,
    recurrence: row.recurrence,
    source: row.source,
    ...(row.source_url ? { source_url: row.source_url } : {}),
    ...(row.mem_observation_id === null
      ? {}
      : { mem_observation_id: row.mem_observation_id }),
    active: row.active === 1,
    ablated_at: row.ablated_at,
  };
}

function isRuling(value: unknown): value is Ruling {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Ruling>;

  return (
    Number.isInteger(candidate.id) &&
    typeof candidate.rule === "string" &&
    typeof candidate.path_glob === "string" &&
    Array.isArray(candidate.forbid) &&
    candidate.forbid.every((pattern) => typeof pattern === "string") &&
    Array.isArray(candidate.require) &&
    candidate.require.every((pattern) => typeof pattern === "string") &&
    typeof candidate.first_pr === "string" &&
    typeof candidate.first_author === "string" &&
    typeof candidate.first_seen === "string" &&
    Number.isInteger(candidate.recurrence) &&
    ["greptile", "github", "seed"].includes(candidate.source ?? "")
  );
}

export class PrecedentStore {
  constructor(private readonly database: Database) {}

  close(): void {
    this.database.close();
  }

  listRulings(options: { activeOnly?: boolean } = {}): StoredRuling[] {
    const sql = options.activeOnly
      ? "SELECT * FROM rulings WHERE active = 1 ORDER BY id"
      : "SELECT * FROM rulings ORDER BY id";
    const rows = this.database.query(sql).all() as RulingRow[];
    return rows.map(toStoredRuling);
  }

  activeRulingsForPaths(paths: readonly string[]): Ruling[] {
    if (paths.length === 0) return [];

    return this.listRulings({ activeOnly: true }).filter((ruling) =>
      paths.some(
        (path) =>
          matchesPathGlob(path, ruling.path_glob) ||
          matchesPathGlob(resolve(path), ruling.path_glob),
      ),
    );
  }

  getRuling(id: number): StoredRuling | null {
    const row = this.database
      .query("SELECT * FROM rulings WHERE id = ?")
      .get(id) as RulingRow | null;
    return row ? toStoredRuling(row) : null;
  }

  ablateRuling(id: number): StoredRuling | null {
    this.database
      .query(
        "UPDATE rulings SET active = 0, ablated_at = ? WHERE id = ? AND active = 1",
      )
      .run(new Date().toISOString(), id);
    return this.getRuling(id);
  }

  restoreRuling(id: number): StoredRuling | null {
    this.database
      .query("UPDATE rulings SET active = 1, ablated_at = NULL WHERE id = ?")
      .run(id);
    return this.getRuling(id);
  }

  insertDecision(decision: Omit<Decision, "id">): Decision {
    const result = this.database
      .query(
        `INSERT INTO decisions
          (ts, session_id, tool, path, ruling_id, outcome, latency_ms, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.ts,
        decision.session_id,
        decision.tool,
        decision.path,
        decision.ruling_id,
        decision.outcome,
        decision.latency_ms,
        decision.reason ?? null,
      );

    return { ...decision, id: Number(result.lastInsertRowid) };
  }

  listDecisions(limit = 100): Decision[] {
    return this.database
      .query(`SELECT * FROM decisions ORDER BY id DESC LIMIT ?`)
      .all(limit) as Decision[];
  }
}

function migrate(database: Database): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS rulings (
      id INTEGER PRIMARY KEY,
      rule TEXT NOT NULL,
      path_glob TEXT NOT NULL,
      forbid_json TEXT NOT NULL,
      require_json TEXT NOT NULL,
      first_pr TEXT NOT NULL,
      first_author TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      recurrence INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('greptile', 'github', 'seed')),
      source_url TEXT,
      mem_observation_id INTEGER,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      ablated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS rulings_active_idx ON rulings(active);

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL CHECK (tool IN ('apply_patch', 'Bash')),
      path TEXT NOT NULL,
      ruling_id INTEGER,
      outcome TEXT NOT NULL CHECK (outcome IN ('allow', 'deny')),
      latency_ms REAL NOT NULL,
      reason TEXT,
      FOREIGN KEY (ruling_id) REFERENCES rulings(id)
    );

    CREATE INDEX IF NOT EXISTS decisions_ts_idx ON decisions(ts);
  `);
}

function seed(database: Database, rulings: readonly Ruling[]): void {
  const upsert = database.query(
    `INSERT INTO rulings
      (id, rule, path_glob, forbid_json, require_json, first_pr, first_author,
       first_seen, recurrence, source, source_url, mem_observation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       rule = excluded.rule,
       path_glob = excluded.path_glob,
       forbid_json = excluded.forbid_json,
       require_json = excluded.require_json,
       first_pr = excluded.first_pr,
       first_author = excluded.first_author,
       first_seen = excluded.first_seen,
       recurrence = excluded.recurrence,
       source = excluded.source,
       source_url = excluded.source_url,
       mem_observation_id = excluded.mem_observation_id`,
  );

  const insertAll = database.transaction((items: readonly Ruling[]) => {
    for (const ruling of items) {
      upsert.run(
        ruling.id,
        ruling.rule,
        ruling.path_glob,
        JSON.stringify(ruling.forbid),
        JSON.stringify(ruling.require),
        ruling.first_pr,
        ruling.first_author,
        ruling.first_seen,
        ruling.recurrence,
        ruling.source,
        ruling.source_url ?? null,
        ruling.mem_observation_id ?? null,
      );
    }
  });

  insertAll(rulings);
}

export async function openStore(
  options: StoreOptions = {},
): Promise<PrecedentStore> {
  const dbPath = options.dbPath ?? process.env.PRECEDENT_DB_PATH ?? DEFAULT_DB_PATH;
  const seedPath = options.seedPath ?? DEFAULT_SEED_PATH;
  const rawSeeds: unknown = await Bun.file(seedPath).json();

  if (!Array.isArray(rawSeeds) || rawSeeds.length !== 2 || !rawSeeds.every(isRuling)) {
    throw new TypeError("fixtures/rulings.seed.json must contain exactly two valid rulings");
  }

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const database = new Database(dbPath, { create: true, strict: true });
  migrate(database);
  seed(database, rawSeeds);

  return new PrecedentStore(database);
}
