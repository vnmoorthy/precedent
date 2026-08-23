import { isAbsolute, relative, resolve } from "node:path";

export type PatchedFile = {
  path: string;
  relPath: string;
  added: string[];
  removed: string[];
  /**
   * Callers that have reconstructed the complete post-patch file may provide it
   * for require-regex checks. Add-file patches can use `added` as the content.
   */
  resultingContent?: string;
};

const FILE_DIRECTIVE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;

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

/** Parse the apply_patch command carried in a Codex PreToolUse payload. */
export function parsePatch(
  command: string,
  repoRoot: string = process.cwd(),
): PatchedFile[] {
  const files: PatchedFile[] = [];
  let current: PatchedFile | undefined;

  for (const rawLine of command.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const directive = FILE_DIRECTIVE.exec(line);

    if (directive) {
      const path = withForwardSlashes(directive[1]!.trim());
      current = {
        path,
        relPath: repositoryRelativePath(path, repoRoot),
        added: [],
        removed: [],
      };
      files.push(current);
      continue;
    }

    if (!current || line.startsWith("*** ") || line.startsWith("@@")) {
      continue;
    }

    if (line.startsWith("+")) {
      current.added.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.removed.push(line.slice(1));
    }
  }

  return files;
}
