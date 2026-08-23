import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluate, matchesPathGlob, type Ruling } from "../src/match.ts";
import {
  parsePatch,
  reconstructUpdatedFile,
  resolvePatchedFilePaths,
} from "../src/patch.ts";

const REPO_ROOT = "/abs/path";

const signatureRuling: Ruling = {
  id: 1,
  rule: "Verify the webhook signature before parsing the body",
  path_glob: "src/webhooks/**",
  forbid: [String.raw`JSON\.parse\(\s*req\.(body|rawBody)`],
  require: ["constructEvent"],
  first_pr: "#388",
  first_author: "@you",
  first_seen: "2026-07-14",
  recurrence: 4,
  source: "seed",
};

function addFilePatch(path: string, ...lines: string[]) {
  return parsePatch(
    [
      "*** Begin Patch",
      `*** Add File: ${REPO_ROOT}/${path}`,
      ...lines.map((line) => `+${line}`),
      "*** End Patch",
    ].join("\n"),
    REPO_ROOT,
  )[0]!;
}

describe("parsePatch", () => {
  test("parses a multi-file apply_patch payload and strips the repository root", () => {
    const command = [
      "*** Begin Patch",
      `*** Add File: ${REPO_ROOT}/src/webhooks/drive.ts`,
      "+export function handleDriveWebhook(event) {",
      "+  return event;",
      "+}",
      `*** Update File: ${REPO_ROOT}/src/webhooks/stripe.ts`,
      "@@",
      "-const e = JSON.parse(req.body)",
      "+const e = stripe.webhooks.constructEvent(req.body, sig, secret)",
      "*** End Patch",
    ].join("\n");

    const files = parsePatch(command, REPO_ROOT);

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      path: `${REPO_ROOT}/src/webhooks/drive.ts`,
      relPath: "src/webhooks/drive.ts",
      sourcePath: `${REPO_ROOT}/src/webhooks/drive.ts`,
      sourceRelPath: "src/webhooks/drive.ts",
      operation: "add",
      added: [
        "export function handleDriveWebhook(event) {",
        "  return event;",
        "}",
      ],
      addedLineNumbers: [1, 2, 3],
      removed: [],
    });
    expect(files[1]).toMatchObject({
      path: `${REPO_ROOT}/src/webhooks/stripe.ts`,
      relPath: "src/webhooks/stripe.ts",
      sourcePath: `${REPO_ROOT}/src/webhooks/stripe.ts`,
      sourceRelPath: "src/webhooks/stripe.ts",
      operation: "update",
      added: [
        "const e = stripe.webhooks.constructEvent(req.body, sig, secret)",
      ],
      addedLineNumbers: [null],
      removed: ["const e = JSON.parse(req.body)"],
    });
  });

  test("stops parsing state at End Patch even when the command has a trailing newline", () => {
    const file = parsePatch(
      [
        "*** Begin Patch",
        `*** Add File: ${REPO_ROOT}/src/webhooks/drive.ts`,
        "+export const ready = true;",
        "*** End Patch",
        "",
      ].join("\n"),
      REPO_ROOT,
    )[0]!;

    expect(file.added).toEqual(["export const ready = true;"]);
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]?.lines).toEqual([
      { kind: "add", text: "export const ready = true;" },
    ]);
  });
});

describe("evaluate", () => {
  test("flags naive JSON.parse(req.body) in src/webhooks without constructEvent", () => {
    const file = addFilePatch(
      "src/webhooks/doordash.ts",
      "const event = JSON.parse(req.body);",
    );

    const violation = evaluate(file, [signatureRuling]);

    expect(violation).not.toBeNull();
    expect(violation?.ruling.id).toBe(1);
    expect(violation?.line).toBe("const event = JSON.parse(req.body);");
    expect(violation?.lineNo).toBe(1);
  });

  test("does not flag a webhook file whose resulting content calls constructEvent", () => {
    const file = addFilePatch(
      "src/webhooks/stripe.ts",
      "const event = JSON.parse(req.body);",
      "stripe.webhooks.constructEvent(req.body, signature, secret);",
    );

    expect(evaluate(file, [signatureRuling])).toBeNull();
  });

  test("existing constructEvent content suppresses a violation in an Update File patch", () => {
    const original = [
      "const verified = stripe.webhooks.constructEvent(req.body, sig, secret);",
      "export const ready = true;",
    ].join("\n");
    const parsed = parsePatch(
      [
        "*** Begin Patch",
        `*** Update File: ${REPO_ROOT}/src/webhooks/stripe.ts`,
        "@@ -2 +2,2 @@",
        " export const ready = true;",
        "+const parsed = JSON.parse(req.body);",
        "*** End Patch",
      ].join("\n"),
      REPO_ROOT,
    )[0]!;
    const reconstructed = reconstructUpdatedFile(parsed, original);

    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.resultingContent).toContain("constructEvent");
    expect(evaluate(reconstructed!, [signatureRuling])).toBeNull();
  });

  test("reports the real added source line from a numbered @@ hunk", () => {
    const originalLines = Array.from(
      { length: 45 },
      (_, index) => `const line${index + 1} = ${index + 1};`,
    );
    const parsed = parsePatch(
      [
        "*** Begin Patch",
        `*** Update File: ${REPO_ROOT}/src/webhooks/stripe.ts`,
        "@@ -40,2 +40,2 @@",
        ` ${originalLines[39]}`,
        `-${originalLines[40]}`,
        "+const parsed = JSON.parse(req.body);",
        "*** End Patch",
      ].join("\n"),
      REPO_ROOT,
    )[0]!;
    const reconstructed = reconstructUpdatedFile(
      parsed,
      `${originalLines.join("\n")}\n`,
    );
    const violation = evaluate(reconstructed!, [signatureRuling]);

    expect(parsed.addedLineNumbers).toEqual([41]);
    expect(reconstructed).not.toBeNull();
    expect(violation?.line).toBe("const parsed = JSON.parse(req.body);");
    expect(violation?.lineNo).toBe(41);
  });

  test("fails open when an Update File hunk cannot be reconstructed", () => {
    const parsed = parsePatch(
      [
        "*** Begin Patch",
        `*** Update File: ${REPO_ROOT}/src/webhooks/stripe.ts`,
        "@@ -1 +1,2 @@",
        " const lineThatIsNotInTheFile = true;",
        "+const parsed = JSON.parse(req.body);",
        "*** End Patch",
      ].join("\n"),
      REPO_ROOT,
    )[0]!;

    expect(reconstructUpdatedFile(parsed, "export const real = true;\n")).toBeNull();
    expect(evaluate(parsed, [signatureRuling])).toBeNull();
  });

  test("matches and reports a Move to destination rather than its source", () => {
    const parsed = parsePatch(
      [
        "*** Begin Patch",
        `*** Update File: ${REPO_ROOT}/src/utils/parse.ts`,
        `*** Move to: ${REPO_ROOT}/src/webhooks/parse.ts`,
        "@@ -1 +1,2 @@",
        " export const ready = true;",
        "+const parsed = JSON.parse(req.body);",
        "*** End Patch",
      ].join("\n"),
      REPO_ROOT,
    )[0]!;
    const reconstructed = reconstructUpdatedFile(
      parsed,
      "export const ready = true;\n",
    );
    const violation = evaluate(reconstructed!, [signatureRuling]);

    expect(parsed.sourceRelPath).toBe("src/utils/parse.ts");
    expect(parsed.relPath).toBe("src/webhooks/parse.ts");
    expect(reconstructed).not.toBeNull();
    expect(violation?.ruling.id).toBe(1);
    expect(violation?.lineNo).toBe(2);
  });

  test("rejects an Update source symlink that canonically escapes the repo", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "precedent-symlink-"));
    const repoRoot = join(sandbox, "repo");
    const outsideFile = join(sandbox, "outside.ts");

    try {
      mkdirSync(join(repoRoot, "src/webhooks"), { recursive: true });
      writeFileSync(outsideFile, "export const outside = true;\n");
      const linkedSource = join(repoRoot, "src/webhooks/linked.ts");
      symlinkSync(outsideFile, linkedSource);
      const parsed = parsePatch(
        [
          "*** Begin Patch",
          `*** Update File: ${linkedSource}`,
          "@@ -1 +1,2 @@",
          " export const outside = true;",
          "+const parsed = JSON.parse(req.body);",
          "*** End Patch",
        ].join("\n"),
        repoRoot,
      )[0]!;

      expect(resolvePatchedFilePaths(parsed, repoRoot)).toBeNull();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("rejects a Move target whose parent symlink canonically escapes the repo", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "precedent-move-symlink-"));
    const repoRoot = join(sandbox, "repo");
    const outsideDirectory = join(sandbox, "outside");

    try {
      mkdirSync(join(repoRoot, "src/utils"), { recursive: true });
      mkdirSync(outsideDirectory, { recursive: true });
      writeFileSync(
        join(repoRoot, "src/utils/parse.ts"),
        "export const ready = true;\n",
      );
      symlinkSync(outsideDirectory, join(repoRoot, "src/webhooks"));
      const parsed = parsePatch(
        [
          "*** Begin Patch",
          `*** Update File: ${join(repoRoot, "src/utils/parse.ts")}`,
          `*** Move to: ${join(repoRoot, "src/webhooks/parse.ts")}`,
          "@@ -1 +1,2 @@",
          " export const ready = true;",
          "+const parsed = JSON.parse(req.body);",
          "*** End Patch",
        ].join("\n"),
        repoRoot,
      )[0]!;

      expect(resolvePatchedFilePaths(parsed, repoRoot)).toBeNull();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("does not flag JSON.parse under src/utils because the path is out of scope", () => {
    const file = addFilePatch(
      "src/utils/parse.ts",
      "const event = JSON.parse(req.body);",
    );

    expect(evaluate(file, [signatureRuling])).toBeNull();
  });

  test("allows a file with zero matching rulings in under 5ms", () => {
    const file = addFilePatch("src/api/orders.ts", "export const ok = true;");

    evaluate(file, [signatureRuling]); // Warm the function before timing the hot path.
    const startedAt = performance.now();
    const violation = evaluate(file, [signatureRuling]);
    const elapsedMs = performance.now() - startedAt;

    expect(violation).toBeNull();
    expect(elapsedMs).toBeLessThan(5);
  });

  test("supports every glob form used by the planned seed rulings", () => {
    expect(
      matchesPathGlob(
        "src/webhooks/stripe.ts",
        "src/(webhooks|payments)/**",
      ),
    ).toBe(true);
    expect(
      matchesPathGlob(
        "src/payments/capture.ts",
        "src/(webhooks|payments)/**",
      ),
    ).toBe(true);
    expect(
      matchesPathGlob(
        "src/webhooks/doordash.ts",
        "src/webhooks/doordash*",
      ),
    ).toBe(true);
    expect(matchesPathGlob("src/api/orders.ts", "**/*.ts")).toBe(true);
  });

  test("fails open when a ruling contains an invalid regex", () => {
    const file = addFilePatch(
      "src/webhooks/doordash.ts",
      "const event = JSON.parse(req.body);",
    );

    expect(
      evaluate(file, [
        { ...signatureRuling, forbid: [...signatureRuling.forbid, "("] },
      ]),
    ).toBeNull();
    expect(
      evaluate(file, [
        { ...signatureRuling, require: [...signatureRuling.require, "("] },
      ]),
    ).toBeNull();
  });
});
