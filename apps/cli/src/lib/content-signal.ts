/**
 * Content-Signal preflight — robots.txt / Content-Signal opt-out gate for the
 * `--local` handoff (`source fetch --local`).
 *
 * This is the thin-client mirror of the monorepo skill's gate at
 * `src/agent/skills/local-ingest/preflight.ts`. The `--local` flow stages local
 * onboarding for the `local-ingest` skill, so before we hand a source off we run
 * the SAME opt-out check the skill runs: if a publisher declares `ai-input=no`
 * or `ai-train=no` via Cloudflare's Content Signals policy in robots.txt, refuse
 * the handoff rather than stage a path that would ingest content against the
 * opt-out. (`conductor.build` serves `Content-Signal: ai-train=no, search=yes,
 * ai-input=no` and must be refused.)
 *
 * The refusal is a POLICY choice, not a technical limit — the bytes are still
 * reachable. Honor the signal anyway; `--force` is the operator escape hatch for
 * sources where there is explicit publisher permission.
 *
 * Dependency-free on purpose: `fetch` + string parsing only, no Anthropic or
 * adapter import. The thin client never extracts.
 */

import { RELEASES_CLI_UA } from "./user-agent.js";

export type ContentSignalVerdict = "proceed" | "refuse" | "unknown";

export interface ContentSignalResult {
  /** The url-or-domain we were asked to check. */
  input: string;
  /** The resolved robots.txt URL we fetched. */
  robotsUrl: string;
  /** HTTP status of the robots.txt fetch, or null when the request never completed. */
  robotsStatus: number | null;
  /** Merged Content-Signal directives (strictest reading), or null when none declared. */
  contentSignal: Record<string, string> | null;
  /** `Sitemap:` URLs surfaced by robots.txt — page discovery prefers these. */
  sitemaps: string[];
  /** The blocking directives that triggered a refusal (e.g. `["ai-input=no"]`). */
  blocked: string[];
  verdict: ContentSignalVerdict;
  reason: string;
}

/** Content-Signal keys whose `=no` value blocks the local-ingest handoff. */
export const BLOCKING_SIGNALS = ["ai-input", "ai-train"] as const;

const ROBOTS_TIMEOUT_MS = 20_000;

/** Map a url-or-bare-domain to its origin's `/robots.txt`. */
export function robotsUrlFor(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return `${new URL(withScheme).origin}/robots.txt`;
}

/**
 * robots.txt served as HTML (not a real policy file) usually means a
 * challenge/login wall — we can't read the opt-out, so fail closed.
 */
export function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 200).toLowerCase().trimStart();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<head");
}

/**
 * Collect every `Content-Signal:` directive in the file and union their
 * key=value pairs, taking the strictest reading across all groups. A publisher
 * declaring an opt-out anywhere is honored: once a signal is `no`, a later `yes`
 * (another line / UA group) must not override it. `Sitemap:` lines are surfaced
 * for page discovery. We deliberately ignore user-agent grouping.
 */
export function parseRobotsTxt(body: string): {
  contentSignal: Record<string, string> | null;
  sitemaps: string[];
  blocked: string[];
} {
  const merged: Record<string, string> = {};
  const sitemaps: string[] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "sitemap" && value) {
      sitemaps.push(value);
      continue;
    }
    if (key !== "content-signal" || !value) continue;

    // e.g. "ai-train=no, search=yes, ai-input=no" — tokens have no internal spaces.
    for (const token of value.split(/[,\s]+/)) {
      const eq = token.indexOf("=");
      if (eq === -1) continue;
      const sig = token.slice(0, eq).trim().toLowerCase();
      if (!sig) continue;
      // Strictest reading: a "no" wins and is never overwritten.
      if (merged[sig] === "no") continue;
      merged[sig] = token
        .slice(eq + 1)
        .trim()
        .toLowerCase();
    }
  }

  const blocked = BLOCKING_SIGNALS.filter((sig) => merged[sig] === "no").map((sig) => `${sig}=no`);
  return { contentSignal: Object.keys(merged).length > 0 ? merged : null, sitemaps, blocked };
}

/**
 * Fetch and evaluate `<origin>/robots.txt` for the given url-or-domain.
 *
 * Verdicts:
 *   proceed — permissive or absent Content-Signal
 *   refuse  — `ai-input=no` or `ai-train=no` declared
 *   unknown — could not fetch/parse robots.txt (network error, non-404 error
 *             status, or an HTML challenge wall); surface, never assume proceed
 *
 * Best-effort and total: never throws. Follows redirects (apex→www `307`s are
 * common, e.g. `conductor.build` → `www.conductor.build/robots.txt`).
 */
export async function contentSignalPreflight(input: string): Promise<ContentSignalResult> {
  const robotsUrl = robotsUrlFor(input);
  const base: Omit<ContentSignalResult, "verdict" | "reason"> = {
    input,
    robotsUrl,
    robotsStatus: null,
    contentSignal: null,
    sitemaps: [],
    blocked: [],
  };

  let res: Response;
  try {
    res = await fetch(robotsUrl, {
      headers: { "User-Agent": RELEASES_CLI_UA, Accept: "text/plain" },
      redirect: "follow", // apex→www 307s are common (e.g. conductor.build)
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ...base,
      verdict: "unknown",
      reason: `Could not fetch robots.txt (${err instanceof Error ? err.message : String(err)}). Surface to the operator — do not assume proceed.`,
    };
  }

  base.robotsStatus = res.status;

  if (res.status === 404 || res.status === 410) {
    return {
      ...base,
      verdict: "proceed",
      reason: `No robots.txt (HTTP ${res.status}) — no opt-out declared.`,
    };
  }
  if (!res.ok) {
    return {
      ...base,
      verdict: "unknown",
      reason: `robots.txt returned HTTP ${res.status}. Surface to the operator — do not assume proceed.`,
    };
  }

  const body = await res.text();
  if (looksLikeHtml(body)) {
    return {
      ...base,
      verdict: "unknown",
      reason:
        "robots.txt served HTML (likely a challenge/login wall) — could not read the opt-out policy. Operator review required before fetching.",
    };
  }

  const { contentSignal, sitemaps, blocked } = parseRobotsTxt(body);
  base.contentSignal = contentSignal;
  base.sitemaps = sitemaps;
  base.blocked = blocked;

  if (blocked.length > 0) {
    return {
      ...base,
      verdict: "refuse",
      reason: `Content-Signal opt-out: ${blocked.join(", ")}. Publisher disallows AI input/training. Pass --force only with explicit publisher permission.`,
    };
  }
  if (!contentSignal) {
    return {
      ...base,
      verdict: "proceed",
      reason: "robots.txt present, no Content-Signal directive — no opt-out declared.",
    };
  }
  return {
    ...base,
    verdict: "proceed",
    reason: "Content-Signal present and permissive for ai-input/ai-train.",
  };
}
