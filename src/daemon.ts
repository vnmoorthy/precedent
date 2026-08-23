import type { Server } from "bun";

import {
  openStore,
  type Decision,
  type PrecedentStore,
} from "./db.ts";
import { evaluate, type Violation } from "./match.ts";
import {
  parsePatch,
  reconstructUpdatedFile,
  resolvePatchedFilePaths,
  type PatchedFile,
} from "./patch.ts";

type HookInput = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string };
};

type DenyPayload = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
};

type Daemon = {
  server: Server<undefined>;
  store: PrecedentStore;
  stop(): void;
};

const encoder = new TextEncoder();

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status,
    statusText: init.statusText,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function allow(): Response {
  // The hook prints a response only when curl receives a body. An empty 204 is
  // therefore the Codex-compatible "allow" response.
  return new Response(null, { status: 204 });
}

function denyReason(file: PatchedFile, violation: Violation): string {
  const ruling = violation.ruling;
  const missingRequirement = ruling.require.length
    ? ` with no ${ruling.require.join(" or ")} call`
    : "";

  return [
    `Precedent: ruling #${ruling.id} — "${ruling.rule}"`,
    `First raised by ${ruling.first_author} in PR ${ruling.first_pr} on ${ruling.first_seen}. Raised ${ruling.recurrence} times.`,
    `Your patch adds \`${violation.line.trim()}\` at ${file.relPath}:${violation.lineNo}${missingRequirement}.`,
  ].join("\n");
}

function denyPayload(reason: string): DenyPayload {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function rulingIdFrom(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { ruling_id?: unknown }).ruling_id;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

function sseResponse(
  clients: Set<ReadableStreamDefaultController<Uint8Array>>,
): Response {
  let activeController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      activeController = controller;
      clients.add(controller);
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      if (activeController) clients.delete(activeController);
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    },
  });
}

function broadcast(
  clients: Set<ReadableStreamDefaultController<Uint8Array>>,
  decision: Decision,
): void {
  const message = encoder.encode(`event: decision\ndata: ${JSON.stringify(decision)}\n\n`);

  for (const client of clients) {
    try {
      client.enqueue(message);
    } catch {
      clients.delete(client);
    }
  }
}

async function prepareForEvaluation(
  file: PatchedFile,
  repoRoot: string,
): Promise<PatchedFile | null> {
  if (file.operation === "add") return file;
  if (file.operation !== "update") return null;

  const resolvedPaths = resolvePatchedFilePaths(file, repoRoot);
  if (!resolvedPaths) return null;

  try {
    // Read the canonical existing source, never a destination or unchecked
    // symlink path. Move destinations are validated but may not exist yet.
    const originalContent = await Bun.file(resolvedPaths.sourcePath).text();
    return reconstructUpdatedFile(file, originalContent);
  } catch {
    return null;
  }
}

async function handleGate(
  request: Request,
  store: PrecedentStore,
  clients: Set<ReadableStreamDefaultController<Uint8Array>>,
): Promise<Response> {
  const startedAt = performance.now();

  try {
    const input = (await readJson(request)) as HookInput | null;
    if (
      !input ||
      input.hook_event_name !== "PreToolUse" ||
      input.tool_name !== "apply_patch" ||
      typeof input.tool_input?.command !== "string"
    ) {
      return allow();
    }

    const repoRoot = input.cwd ?? process.cwd();
    const files = parsePatch(input.tool_input.command, repoRoot);
    if (files.length === 0) return allow();

    for (const file of files) {
      const relevantRulings = store.activeRulingsForPaths([
        file.relPath,
        file.path,
      ]);
      if (relevantRulings.length === 0) continue;

      const prepared = await prepareForEvaluation(file, repoRoot);
      if (!prepared) continue;

      const violation = evaluate(prepared, relevantRulings);
      if (!violation) continue;

      const reason = denyReason(prepared, violation);
      const decision = store.insertDecision({
        ts: new Date().toISOString(),
        session_id: input.session_id ?? "unknown",
        tool: "apply_patch",
        path: file.relPath,
        ruling_id: violation.ruling.id,
        outcome: "deny",
        latency_ms: Number((performance.now() - startedAt).toFixed(3)),
        reason,
      });
      broadcast(clients, decision);
      return json(denyPayload(reason));
    }

    return allow();
  } catch (error) {
    // The enforcement layer must never strand Codex because its daemon failed.
    console.error("Precedent gate failed open:", error);
    return allow();
  }
}

export async function startDaemon(options: {
  port?: number;
  hostname?: string;
} = {}): Promise<Daemon> {
  const store = await openStore();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const port = options.port ?? Number(process.env.PRECEDENT_PORT ?? 4747);
  const hostname = options.hostname ?? "127.0.0.1";

  const server = Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/board")) {
        return new Response(Bun.file(`${import.meta.dir}/board/index.html`), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "POST" && url.pathname === "/gate") {
        return handleGate(request, store, clients);
      }
      if (request.method === "GET" && url.pathname === "/rulings") {
        return json(store.listRulings());
      }
      if (request.method === "GET" && url.pathname === "/events") {
        return sseResponse(clients);
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/ablate" || url.pathname === "/restore")
      ) {
        const rulingId = rulingIdFrom(await readJson(request));
        if (rulingId === null) {
          return json({ error: "ruling_id must be a positive integer" }, { status: 400 });
        }

        const ruling =
          url.pathname === "/ablate"
            ? store.ablateRuling(rulingId)
            : store.restoreRuling(rulingId);
        return ruling
          ? json(ruling)
          : json({ error: `Ruling ${rulingId} not found` }, { status: 404 });
      }

      return json({ error: "Not found" }, { status: 404 });
    },
  });

  const stop = () => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // The client may already have disconnected.
      }
    }
    clients.clear();
    server.stop(true);
    store.close();
  };

  return { server, store, stop };
}

if (import.meta.main) {
  const daemon = await startDaemon();
  console.log(`Precedent daemon listening on http://${daemon.server.hostname}:${daemon.server.port}`);

  const shutdown = () => {
    daemon.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
