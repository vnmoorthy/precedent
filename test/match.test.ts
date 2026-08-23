import { describe, expect, test } from "bun:test";

import { evaluate, matchesPathGlob, type Ruling } from "../src/match.ts";
import { parsePatch } from "../src/patch.ts";

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

    expect(parsePatch(command, REPO_ROOT)).toEqual([
      {
        path: `${REPO_ROOT}/src/webhooks/drive.ts`,
        relPath: "src/webhooks/drive.ts",
        added: [
          "export function handleDriveWebhook(event) {",
          "  return event;",
          "}",
        ],
        removed: [],
      },
      {
        path: `${REPO_ROOT}/src/webhooks/stripe.ts`,
        relPath: "src/webhooks/stripe.ts",
        added: [
          "const e = stripe.webhooks.constructEvent(req.body, sig, secret)",
        ],
        removed: ["const e = JSON.parse(req.body)"],
      },
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
