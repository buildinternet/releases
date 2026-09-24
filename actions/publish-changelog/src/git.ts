import { execFileSync } from "node:child_process";

/** True when `sha` is missing or an all-zero first-push SHA. */
export function isMissingOrZeroSha(sha: string | undefined): boolean {
  return !sha || /^0+$/.test(sha);
}

/** Empty string when `sha` is missing, an all-zero first-push SHA, or the path is new. */
export function gitShowFile(sha: string | undefined, path: string, cwd?: string): string {
  if (isMissingOrZeroSha(sha)) return "";
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], {
      encoding: "utf8",
      cwd,
    });
  } catch {
    return "";
  }
}

export type NameStatusEntry = {
  status: "A" | "M" | "D";
  path: string;
};

function parseNameStatusLine(line: string): NameStatusEntry | null {
  const parts = line.split("\t");
  const rawStatus = parts[0];
  if (!rawStatus) return null;
  if (rawStatus.startsWith("R") || rawStatus.startsWith("C")) {
    // Rename/copy: "R100\told\tnew" — treat as modified at the new path.
    const newPath = parts[2] ?? parts[1];
    if (!newPath) return null;
    return { status: "M", path: newPath };
  }
  const path = parts[1];
  if (!path) return null;
  if (rawStatus.startsWith("A")) return { status: "A", path };
  if (rawStatus.startsWith("D")) return { status: "D", path };
  // M, T, U, etc. — treat as modified.
  return { status: "M", path };
}

/**
 * `git diff --name-status -M --relative <before>..HEAD`, filtered to files
 * git touched between the before-push SHA and the current commit. Paths are
 * relative to `cwd` (the resolved working-directory). Empty when `before` is
 * missing or an all-zero first-push SHA — callers should treat that as "diff
 * everything" the same way the single-file path does.
 */
export function gitDiffNameStatus(before: string | undefined, cwd?: string): NameStatusEntry[] {
  if (isMissingOrZeroSha(before)) return [];
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-status", "-M", "--relative", `${before}..HEAD`],
      { encoding: "utf8", cwd },
    );
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseNameStatusLine)
      .filter((entry): entry is NameStatusEntry => entry !== null);
  } catch {
    return [];
  }
}
