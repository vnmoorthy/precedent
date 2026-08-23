import { lstatSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export type PatchOperation = "add" | "update" | "delete";

export type PatchHunkLine = {
  kind: "context" | "add" | "remove";
  text: string;
};

export type PatchHunk = {
  oldStart: number | null;
  oldCount: number | null;
  newStart: number | null;
  newCount: number | null;
  lines: PatchHunkLine[];
};

export type PatchedFile = {
  /** Destination path used for matching, reporting, and the resulting file. */
  path: string;
  relPath: string;
  /** Existing source path used only to reconstruct Update File patches. */
  sourcePath: string;
  sourceRelPath: string;
  operation: PatchOperation;
  added: string[];
  addedLineNumbers: Array<number | null>;
  removed: string[];
  hunks: PatchHunk[];
  /**
   * Callers that have reconstructed the complete post-patch file may provide it
   * for require-regex checks. Add-file patches can use `added` as the content.
   */
  resultingContent?: string;
};

const FILE_DIRECTIVE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE_DIRECTIVE = /^\*\*\* Move to: (.+)$/;
const NUMBERED_HUNK =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function withForwardSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

function repositoryRelativePath(path: string, repoRoot: string): string {
  const normalizedPath = withForwardSlashes(path);

  if (!isAbsolute(path)) {
    return normalizedPath.replace(/^\.\//, "");
  }

  const normalizedRoot = withForwardSlashes(resolve(repoRoot));
  const candidate = withForwardSlashes(relative(normalizedRoot, path));

  // An absolute path outside the repository must not masquerade as an in-scope
  // relative path. Keeping it absolute makes relative ruling globs fail open.
  if (
    candidate === ".." ||
    candidate.startsWith("../") ||
    isAbsolute(candidate)
  ) {
    return normalizedPath;
  }

  return candidate;
}

function operationFromDirective(value: string): PatchOperation {
  return value.toLowerCase() as PatchOperation;
}

function hunkFromHeader(header: string): PatchHunk {
  const match = NUMBERED_HUNK.exec(header);
  if (!match) {
    return {
      oldStart: null,
      oldCount: null,
      newStart: null,
      newCount: null,
      lines: [],
    };
  }

  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
    lines: [],
  };
}

function implicitHunk(): PatchHunk {
  return {
    oldStart: null,
    oldCount: null,
    newStart: null,
    newCount: null,
    lines: [],
  };
}

/** Parse the apply_patch command carried in a Codex PreToolUse payload. */
export function parsePatch(
  command: string,
  repoRoot: string = process.cwd(),
): PatchedFile[] {
  const files: PatchedFile[] = [];
  let current: PatchedFile | undefined;
  let currentHunk: PatchHunk | undefined;
  let currentNewLine: number | null = null;

  for (const rawLine of command.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line === "*** End Patch") {
      current = undefined;
      currentHunk = undefined;
      currentNewLine = null;
      continue;
    }

    const directive = FILE_DIRECTIVE.exec(line);

    if (directive) {
      const path = withForwardSlashes(directive[2]!.trim());
      current = {
        path,
        relPath: repositoryRelativePath(path, repoRoot),
        sourcePath: path,
        sourceRelPath: repositoryRelativePath(path, repoRoot),
        operation: operationFromDirective(directive[1]!),
        added: [],
        addedLineNumbers: [],
        removed: [],
        hunks: [],
      };
      files.push(current);
      currentHunk = undefined;
      currentNewLine = current.operation === "add" ? 1 : null;
      continue;
    }

    const move = MOVE_DIRECTIVE.exec(line);
    if (move && current?.operation === "update") {
      const destination = withForwardSlashes(move[1]!.trim());
      current.path = destination;
      current.relPath = repositoryRelativePath(destination, repoRoot);
      continue;
    }

    if (!current || line.startsWith("*** ")) {
      continue;
    }

    if (line.startsWith("@@")) {
      currentHunk = hunkFromHeader(line);
      current.hunks.push(currentHunk);
      currentNewLine = currentHunk.newStart;
      continue;
    }

    if (line === "\\ No newline at end of file") continue;

    if (!currentHunk) {
      currentHunk = implicitHunk();
      current.hunks.push(currentHunk);
    }

    if (line.startsWith("+")) {
      const text = line.slice(1);
      current.added.push(text);
      current.addedLineNumbers.push(
        current.operation === "add"
          ? current.added.length
          : currentNewLine,
      );
      currentHunk.lines.push({ kind: "add", text });
      if (currentNewLine !== null) currentNewLine += 1;
    } else if (line.startsWith("-")) {
      const text = line.slice(1);
      current.removed.push(text);
      currentHunk.lines.push({ kind: "remove", text });
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      currentHunk.lines.push({ kind: "context", text });
      if (currentNewLine !== null) currentNewLine += 1;
    }
  }

  return files;
}

function splitContent(content: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  const normalized = content.replaceAll("\r\n", "\n");
  const trailingNewline = normalized.endsWith("\n");
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  return {
    lines: body.length === 0 ? [] : body.split("\n"),
    trailingNewline,
  };
}

function matchesAt(
  source: readonly string[],
  expected: readonly string[],
  start: number,
): boolean {
  if (start + expected.length > source.length) return false;
  return expected.every((line, index) => source[start + index] === line);
}

function findUniqueHunkStart(
  source: readonly string[],
  expected: readonly string[],
  startAt: number,
): number | null {
  if (expected.length === 0) return null;
  let found: number | null = null;

  for (let index = startAt; index <= source.length - expected.length; index += 1) {
    if (!matchesAt(source, expected, index)) continue;
    if (found !== null) return null;
    found = index;
  }

  return found;
}

/**
 * Apply parsed update hunks to the current file content. Any ambiguity or
 * context/removal mismatch returns null so callers can fail open.
 */
export function reconstructUpdatedFile(
  file: PatchedFile,
  originalContent: string,
): PatchedFile | null {
  if (file.operation !== "update" || file.hunks.length === 0) return null;

  const { lines: originalLines, trailingNewline } = splitContent(originalContent);
  const result: string[] = [];
  const addedLineNumbers: number[] = [];
  let sourceCursor = 0;

  for (const hunk of file.hunks) {
    const oldSequence = hunk.lines
      .filter((line) => line.kind !== "add")
      .map((line) => line.text);
    const target =
      hunk.oldStart === null
        ? findUniqueHunkStart(originalLines, oldSequence, sourceCursor)
        : hunk.oldStart === 0
          ? 0
          : hunk.oldStart - 1;

    if (target === null || target < sourceCursor || target > originalLines.length) {
      return null;
    }

    result.push(...originalLines.slice(sourceCursor, target));
    const expectedNewIndex =
      hunk.newStart === null ? null : hunk.newStart === 0 ? 0 : hunk.newStart - 1;
    if (expectedNewIndex !== null && result.length !== expectedNewIndex) {
      return null;
    }

    let sourceIndex = target;
    let consumedOld = 0;
    let producedNew = 0;

    for (const line of hunk.lines) {
      if (line.kind === "add") {
        result.push(line.text);
        addedLineNumbers.push(result.length);
        producedNew += 1;
        continue;
      }

      if (originalLines[sourceIndex] !== line.text) return null;
      sourceIndex += 1;
      consumedOld += 1;

      if (line.kind === "context") {
        result.push(line.text);
        producedNew += 1;
      }
    }

    if (
      (hunk.oldCount !== null && consumedOld !== hunk.oldCount) ||
      (hunk.newCount !== null && producedNew !== hunk.newCount)
    ) {
      return null;
    }

    sourceCursor = sourceIndex;
  }

  result.push(...originalLines.slice(sourceCursor));
  if (addedLineNumbers.length !== file.added.length) return null;

  return {
    ...file,
    addedLineNumbers,
    resultingContent: `${result.join("\n")}${trailingNewline ? "\n" : ""}`,
  };
}

export type ResolvedPatchedPaths = {
  rootPath: string;
  sourcePath: string;
  targetPath: string;
};

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function canonicalizeTarget(target: string): string | null {
  let cursor = target;
  const missingSegments: string[] = [];

  while (true) {
    try {
      // Distinguish a genuinely missing path (walk to its parent) from an
      // existing but unresolvable entry such as a dangling symlink.
      lstatSync(cursor);
    } catch (error) {
      if (!isMissingPathError(error)) return null;
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
      continue;
    }

    try {
      return resolve(realpathSync(cursor), ...missingSegments);
    } catch {
      return null;
    }
  }
}

function isContained(root: string, candidate: string): boolean {
  const candidateRelative = relative(root, candidate);
  return (
    candidateRelative === "" ||
    (candidateRelative !== ".." &&
      !candidateRelative.startsWith(`..${sep}`) &&
      !isAbsolute(candidateRelative))
  );
}

/**
 * Canonicalize an Update source and destination and require both to remain
 * under the canonical hook working tree. The source must already exist; a
 * missing destination is resolved through its nearest existing parent.
 */
export function resolvePatchedFilePaths(
  file: PatchedFile,
  repoRoot: string,
): ResolvedPatchedPaths | null {
  try {
    const lexicalRoot = resolve(repoRoot);
    const rootPath = realpathSync(lexicalRoot);
    const lexicalSource = isAbsolute(file.sourcePath)
      ? resolve(file.sourcePath)
      : resolve(lexicalRoot, file.sourcePath);
    const lexicalTarget = isAbsolute(file.path)
      ? resolve(file.path)
      : resolve(lexicalRoot, file.path);
    const sourcePath = realpathSync(lexicalSource);
    const targetPath = canonicalizeTarget(lexicalTarget);

    if (
      !targetPath ||
      !isContained(rootPath, sourcePath) ||
      !isContained(rootPath, targetPath)
    ) {
      return null;
    }

    return { rootPath, sourcePath, targetPath };
  } catch {
    return null;
  }
}
