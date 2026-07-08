#!/usr/bin/env bun
/**
 * local-ingest preflight — robots.txt / Content-Signal safety gate.
 *
 * Run BEFORE fetching or extracting any page in the local-ingest skill. It is
 * the mandatory opt-out check: if a publisher declares `ai-input=no` via
 * Cloudflare's Content Signals policy in robots.txt, the local-ingest path must
 * STOP rather than silently spend tokens or ingest content against the opt-out.
 *
 * We gate on `ai-input` only, NOT `ai-train`: local-ingest performs AI search /
 * input ingestion (feeding a search index), which is exactly what `ai-input`
 * governs. `ai-train=no` opts out of model *training* — a different use we don't
 * perform — so a publisher permitting `ai-input=yes` while setting `ai-train=no`
 * (e.g. `vercel.com`) must be allowed through, not refused. (The Conductor case —
 * `conductor.build` serves `Content-Signal: ai-train=no, search=yes, ai-input=no`
 * — is still correctly refused, via its `ai-input=no`.)
 *
 * The refusal is a POLICY choice, not a technical limit: `web_fetch` and CF
 * Browser Rendering can still retrieve these pages. Honor the signal anyway.
 * Only override with explicit publisher permission (the CLI flag exposes
 * `--force`; the skill requires a human go-ahead).
 *
 * Usage:
 *   bun preflight.ts <url-or-domain> [--json]
 *
 * Exit codes (so callers can gate deterministically):
 *   0  proceed  — permissive or absent Content-Signal
 *   1  refuse   — ai-input=no
 *   2  unknown  — could not fetch/parse robots.txt; surface to the user, do not assume proceed
 *
 * Dependency-free: fetch + string parsing only. Runs anywhere bun runs.
 */

type Verdict = "proceed" | "refuse" | "unknown";

interface PreflightResult {
  input: string;
  robotsUrl: string;
  robotsStatus: number | null;
  contentSignal: Record<string, string> | null;
  sitemaps: string[];
  verdict: Verdict;
  reason: string;
}

// Mirrors WEB_BOT_AUTH_USER_AGENT (packages/core web-bot-auth) — kept inline so this
// stays dependency-free and runnable standalone (the thin-client CLI mirrors the same value).
const UA = "releases/0.1 (+https://releases.sh)";
// Gate on ai-input only — local-ingest is search/input ingestion, not model
// training. ai-train=no alone must NOT refuse (see the docstring above).
const BLOCKING_SIGNALS = ["ai-input"] as const;

const VERDICT_LABEL: Record<Verdict, string> = {
  proceed: "PROCEED",
  refuse: "REFUSE",
  unknown: "UNKNOWN",
};
const VERDICT_EXIT: Record<Verdict, number> = { proceed: 0, refuse: 1, unknown: 2 };

function robotsUrlFor(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const origin = new URL(withScheme).origin;
  return `${origin}/robots.txt`;
}

function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 200).toLowerCase().trimStart();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<head");
}

/**
 * Collect every `Content-Signal:` directive in the file and union their
 * key=value pairs. We deliberately ignore user-agent grouping and take the
 * strictest reading across all groups — a publisher declaring an opt-out
 * anywhere is honored. Later occurrences of a key win on merge, but a single
 * `=no` on a blocking signal anywhere triggers refusal regardless.
 */
function parseRobots(body: string): {
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

    // e.g. "ai-train=no, search=yes, ai-input=no" — tokens have no internal spaces
    for (const token of value.split(/[,\s]+/)) {
      const eq = token.indexOf("=");
      if (eq === -1) continue;
      const sig = token.slice(0, eq).trim().toLowerCase();
      if (!sig) continue;
      // Strictest reading: a "no" wins. Once a signal is "no", a later "yes"
      // (another line / UA group) must not override the opt-out.
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

async function preflight(input: string): Promise<PreflightResult> {
  const robotsUrl = robotsUrlFor(input);
  const base: Omit<PreflightResult, "verdict" | "reason"> = {
    input,
    robotsUrl,
    robotsStatus: null,
    contentSignal: null,
    sitemaps: [],
  };

  let res: Response;
  try {
    res = await fetch(robotsUrl, {
      headers: { "User-Agent": UA, Accept: "text/plain" },
      redirect: "follow", // apex→www 307s are common (e.g. conductor.build)
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return {
      ...base,
      verdict: "unknown",
      reason: `Could not fetch robots.txt (${err instanceof Error ? err.message : String(err)}). Surface to the user — do not assume proceed.`,
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
      reason: `robots.txt returned HTTP ${res.status}. Surface to the user — do not assume proceed.`,
    };
  }

  const body = await res.text();
  // robots.txt served as HTML (not a real policy file) usually means a challenge/login wall — we
  // can't read the opt-out, so fail closed: surface to the operator rather than assume permissive.
  if (looksLikeHtml(body)) {
    return {
      ...base,
      verdict: "unknown",
      reason:
        "robots.txt served HTML (likely a challenge/login wall) — could not read the opt-out policy. Operator review required before fetching.",
    };
  }

  const { contentSignal, sitemaps, blocked } = parseRobots(body);
  base.contentSignal = contentSignal;
  base.sitemaps = sitemaps;

  if (blocked.length > 0) {
    return {
      ...base,
      verdict: "refuse",
      reason: `Content-Signal opt-out: ${blocked.join(", ")}. Publisher disallows AI input. STOP — do not fetch or write without explicit permission.`,
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
    reason: "Content-Signal present and permissive for ai-input.",
  };
}

function printHuman(r: PreflightResult): void {
  console.log(`[preflight] ${VERDICT_LABEL[r.verdict]}  ${r.input}`);
  console.log(`  robots:  ${r.robotsUrl} (HTTP ${r.robotsStatus ?? "—"})`);
  if (r.contentSignal) {
    const pairs = Object.entries(r.contentSignal)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`  signal:  ${pairs}`);
  }
  if (r.sitemaps.length) console.log(`  sitemap: ${r.sitemaps.join(", ")}`);
  console.log(`  reason:  ${r.reason}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const target = args.find((a) => !a.startsWith("--"));

  if (!target || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun preflight.ts <url-or-domain> [--json]");
    console.log("Exit codes: 0 proceed, 1 refuse, 2 unknown");
    process.exit(target ? 0 : 2);
  }

  const result = await preflight(target);
  if (json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);

  process.exit(VERDICT_EXIT[result.verdict]);
}

void main();
