import type { PatchedFile } from "./patch.ts";

export type Ruling = {
  id: number;
  rule: string;
  path_glob: string;
  forbid: string[];
  require: string[];
  first_pr: string;
  first_author: string;
  first_seen: string;
  recurrence: number;
  source: "greptile" | "github" | "seed";
  source_url?: string;
  mem_observation_id?: number;
};

export type Violation = {
  ruling: Ruling;
  line: string;
  lineNo: number;
};

type CompiledRuling = {
  forbid: RegExp[];
  require: RegExp[];
};

const REGEXP_SPECIAL = new Set([
  "\\",
  "^",
  "$",
  "+",
  ".",
  "(",
  ")",
  "|",
  "{",
  "}",
  "[",
  "]",
]);

function escapeLiteral(character: string): string {
  return REGEXP_SPECIAL.has(character) ? `\\${character}` : character;
}

function globFragmentToRegex(glob: string): string {
  let regex = "";

  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;

    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        while (glob[index + 1] === "*") index += 1;

        if (glob[index + 1] === "/") {
          index += 1;
          regex += "(?:.*/)?";
        } else {
          regex += ".*";
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (character === "?") {
      regex += "[^/]";
      continue;
    }

    const closing = character === "(" ? ")" : character === "{" ? "}" : "";
    const separator = character === "(" ? "|" : character === "{" ? "," : "";

    if (closing) {
      const closingIndex = glob.indexOf(closing, index + 1);
      const body = closingIndex === -1 ? "" : glob.slice(index + 1, closingIndex);
      const alternatives = body.split(separator);

      if (closingIndex !== -1 && alternatives.length > 1) {
        regex += `(?:${alternatives.map(globFragmentToRegex).join("|")})`;
        index = closingIndex;
        continue;
      }
    }

    regex += escapeLiteral(character);
  }

  return regex;
}

function compileGlob(glob: string): RegExp | null {
  try {
    const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
    return new RegExp(`^${globFragmentToRegex(normalized)}$`);
  } catch {
    return null;
  }
}

function compileRuling(ruling: Ruling): CompiledRuling | null {
  try {
    return {
      forbid: ruling.forbid.map((pattern) => new RegExp(pattern)),
      require: ruling.require.map((pattern) => new RegExp(pattern)),
    };
  } catch {
    // A malformed mined predicate must never block the agent.
    return null;
  }
}

export function matchesPathGlob(path: string, glob: string): boolean {
  const matcher = compileGlob(glob);
  if (!matcher) return false;

  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return matcher.test(normalizedPath);
}

/** Evaluate Tier 1 deterministic predicates only. */
export function evaluate(
  file: PatchedFile,
  rulings: readonly Ruling[],
): Violation | null {
  for (const ruling of rulings) {
    const inScope =
      matchesPathGlob(file.relPath, ruling.path_glob) ||
      matchesPathGlob(file.path, ruling.path_glob);
    if (!inScope) continue;

    const compiled = compileRuling(ruling);
    if (!compiled) continue;

    const candidateIndex = file.added.findIndex((line) =>
      compiled.forbid.some((pattern) => pattern.test(line)),
    );
    if (candidateIndex === -1) continue;

    const resultingContent = file.resultingContent ?? file.added.join("\n");
    const requirementIsPresent = compiled.require.some((pattern) =>
      pattern.test(resultingContent),
    );
    if (requirementIsPresent) continue;

    return {
      ruling,
      line: file.added[candidateIndex]!,
      lineNo: candidateIndex + 1,
    };
  }

  return null;
}
