import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getDataDir } from "@releases/lib/config";
import { VERSION } from "./version.js";

const CACHE_FILE = "update-check.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 2000;
const NPM_PACKAGE = "@buildinternet/releases";

interface CachedCheck {
  latest: string;
  checkedAt: number;
}

function cachePath(): string {
  return join(getDataDir(), CACHE_FILE);
}

function readCache(): CachedCheck | null {
  try {
    const path = cachePath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8")) as CachedCheck;
    if (typeof data.latest !== "string" || typeof data.checkedAt !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  try {
    writeFileSync(cachePath(), JSON.stringify({ latest, checkedAt: Date.now() }), "utf8");
  } catch {
    // best-effort
  }
}

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map(Number);
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] ?? 0;
    const cv = c[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

function detectInstallMethod(): "npm" | "homebrew" | "unknown" {
  try {
    const execPath = process.execPath || "";
    if (execPath.includes("homebrew") || execPath.includes("Cellar")) return "homebrew";
    // npm-installed binaries live under node_modules
    const argv1 = process.argv[1] || "";
    if (argv1.includes("node_modules")) return "npm";
  } catch {
    // fall through
  }
  return "npm";
}

function upgradeHint(method: ReturnType<typeof detectInstallMethod>): string {
  switch (method) {
    case "homebrew":
      return "brew upgrade releases";
    default:
      return "npm update -g @buildinternet/releases";
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`,
        {
          headers: { accept: "application/json" },
          signal: controller.signal,
        },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: string };
      return data.version ?? null;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

/**
 * Check for a newer CLI version. Returns a formatted notice string
 * if an update is available, or null if current/unable to check.
 * Non-blocking, never throws.
 */
export async function checkForUpdate(): Promise<string | null> {
  try {
    // Skip update checks when running from source (bun src/index.ts)
    if (process.argv[1]?.endsWith(".ts")) return null;

    const cached = readCache();
    const now = Date.now();

    let latest: string | null = null;

    if (cached && now - cached.checkedAt < CHECK_INTERVAL_MS) {
      latest = cached.latest;
    } else {
      latest = await fetchLatestVersion();
      if (latest) writeCache(latest);
    }

    if (!latest || !isNewer(latest, VERSION)) return null;

    const method = detectInstallMethod();
    const hint = upgradeHint(method);
    return `\x1b[2mUpdate available: ${VERSION} → ${latest}  Run: ${hint}\x1b[0m`;
  } catch {
    return null;
  }
}
