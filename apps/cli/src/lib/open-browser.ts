import { spawn } from "node:child_process";

/** Resolve the OS-specific command to open a URL in the default browser. */
export function browserCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}

/**
 * Best-effort: open `url` in the default browser, detached. Returns false if the
 * launch throws (headless box, missing opener) so the caller can fall back to
 * printing the URL for manual opening. Never throws.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const { cmd, args } = browserCommand(platform, url);
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
