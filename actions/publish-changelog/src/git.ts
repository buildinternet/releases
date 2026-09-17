import { execFileSync } from "node:child_process";

/** Empty string when `sha` is missing, an all-zero first-push SHA, or the path is new. */
export function gitShowFile(sha: string | undefined, path: string, cwd?: string): string {
  if (!sha || /^0+$/.test(sha)) return "";
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], {
      encoding: "utf8",
      cwd,
    });
  } catch {
    return "";
  }
}
