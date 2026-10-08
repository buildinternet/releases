/**
 * Git I/O for `--since`. Planning itself lives in
 * `@buildinternet/releases-core/changelog-publish` and takes snapshots plus
 * name-status rows as inputs.
 *
 * `git show <rev>:<path>` resolves `<path>` from the repository root unless it
 * starts with `./` or `../`, in which case it is relative to `cwd`. Changelog
 * paths are cwd-relative (`--cwd`, or the process working directory), so a
 * snapshot is requested as `./<path>`.
 */
import { execFileSync } from "node:child_process";
import { isMissingOrZeroSha } from "@buildinternet/releases-core/changelog-publish";
import { CliError } from "../errors.js";

export { isMissingOrZeroSha };

/**
 * Reject a nonzero `--since` that is not a commit in this checkout.
 * An all-zero or omitted SHA is a first publish and is not checked.
 * A commit that exists but does not contain the changelog file is valid —
 * that file is new, and the snapshot is empty.
 */
export function assertGitCommit(sha: string, cwd?: string): void {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`],
      { stdio: "ignore", cwd },
    );
  } catch {
    throw new CliError(`--since does not resolve to a commit in this checkout: ${sha}`);
  }
}

/** `./<path>` so `git show <rev>:<path>` resolves from `cwd`, not the repo root. */
function snapshotPath(path: string): string {
  if (path.startsWith("./") || path.startsWith("../") || path.startsWith("/")) return path;
  return `./${path}`;
}

/** Empty string when `sha` is missing, an all-zero first-push SHA, or the path is new. */
export function gitShowFile(sha: string | undefined, path: string, cwd?: string): string {
  if (isMissingOrZeroSha(sha)) return "";
  try {
    return execFileSync("git", ["show", `${sha}:${snapshotPath(path)}`], {
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
 * relative to `cwd` (the resolved working-directory). Returns null when
 * `before` is missing or an all-zero first-push SHA. Callers reject a nonzero
 * SHA that is not a commit before calling this. A diff that still fails is
 * treated as "publish everything"; the batch upsert makes a repeat safe.
 */
export function gitDiffNameStatus(
  before: string | undefined,
  cwd?: string,
): NameStatusEntry[] | null {
  if (isMissingOrZeroSha(before)) return null;
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
    return null;
  }
}
