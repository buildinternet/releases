#!/usr/bin/env bun
/**
 * Classifies how we could detect content change on the sources that the
 * hourly poll-and-fetch cron can't reach today — `type IN ('scrape','agent')`
 * with no cached `feedUrl`. Phase 0 of #514 (issue #515); feeds the typed
 * `fetchQuirks` playbook field in Phase 1 (#516) and the `pollOne`
 * change-detector in Phase 2 (#517).
 *
 * Classification (first match wins):
 *   - `etag`          — 2 HEADs return the same non-empty ETag. Cheap: cron can
 *                       use If-None-Match and get 304 on unchanged content.
 *   - `content-length`— No stable ETag but same Content-Length across 2 HEADs.
 *                       Weak signal; misses same-size edits but fine for
 *                       append-only changelogs.
 *   - `body-hash`     — No validator, but GET + SHA-256 is stable across 2
 *                       requests. Works, pays full-body bandwidth per poll.
 *   - `unreliable`    — Nothing stable. Phase 3 force-drain cron handles these.
 *
 * Read-only. No writes to D1 or the API. Output is a markdown report at
 * `.context/515-change-detectors.md` plus per-source progress on stderr.
 *
 * Usage:
 *   bun scripts/probe-change-detectors.ts              # all stranded sources
 *   bun scripts/probe-change-detectors.ts --slug <x>   # one source
 *   bun scripts/probe-change-detectors.ts --json       # JSON to stdout
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RELEASES_BOT_UA } from "../packages/adapters/src/user-agent.js";

type SourceRow = {
  slug: string;
  name: string;
  type: string;
  url: string;
  metadata?: string | null;
};

type Candidate = SourceRow & { parsedMetadata: Record<string, unknown> };

type QuirkClass = "etag" | "content-length" | "body-hash" | "unreliable";

type Probe = {
  slug: string;
  name: string;
  sourceType: string;
  pageUrl: string;
  class: QuirkClass;
  rationale: string;
  etag?: string;
  contentLength?: string;
  lastModified?: string;
  error?: string;
};

const API_URL = process.env.RELEASED_API_URL ?? "https://api.releases.sh";

const args = new Set(process.argv.slice(2));
const jsonOut = args.has("--json");
const slugFilter = (() => {
  const i = process.argv.indexOf("--slug");
  return i > -1 ? process.argv[i + 1] : null;
})();

const HEAD_GAP_MS = 5_000;
const BODY_GAP_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
}

async function listCandidates(): Promise<Candidate[]> {
  const res = await fetch(`${API_URL}/v1/sources?limit=500`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const rows = (await res.json()) as SourceRow[];
  const candidates: Candidate[] = [];
  for (const r of rows) {
    if (r.type !== "scrape" && r.type !== "agent") continue;
    if (slugFilter && r.slug !== slugFilter) continue;
    const parsedMetadata = parseMetadata(r.metadata);
    if (parsedMetadata.feedUrl != null) continue;
    candidates.push({ ...r, parsedMetadata });
  }
  return candidates;
}

async function headOnce(url: string): Promise<Headers | null> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": RELEASES_BOT_UA },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return res.headers;
  } catch {
    return null;
  }
}

async function bodyHash(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": RELEASES_BOT_UA },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return createHash("sha256").update(text).digest("hex");
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function classify(row: Candidate): Promise<Probe> {
  const base: Omit<Probe, "class" | "rationale"> = {
    slug: row.slug,
    name: row.name,
    sourceType: row.type,
    pageUrl: row.url,
  };

  const h1 = await headOnce(row.url);
  await sleep(HEAD_GAP_MS);
  const h2 = await headOnce(row.url);

  if (!h1 || !h2) {
    // HEAD failed or non-200 — fall back to hash probe; some servers
    // 405 HEAD but GET fine.
    const b1 = await bodyHash(row.url);
    if (!b1) {
      return {
        ...base,
        class: "unreliable",
        rationale: "Neither HEAD nor GET returned 200.",
        error: "HEAD + GET both failed",
      };
    }
    await sleep(BODY_GAP_MS);
    const b2 = await bodyHash(row.url);
    if (b1 === b2) {
      return {
        ...base,
        class: "body-hash",
        rationale: "HEAD unsupported; GET body SHA-256 stable across two requests.",
      };
    }
    return {
      ...base,
      class: "unreliable",
      rationale: "HEAD unsupported and GET body hash differs per request.",
    };
  }

  const e1 = h1.get("etag");
  const e2 = h2.get("etag");
  const cl1 = h1.get("content-length");
  const cl2 = h2.get("content-length");
  const lm1 = h1.get("last-modified");
  const lm2 = h2.get("last-modified");

  if (e1 && e2 && e1 === e2) {
    return {
      ...base,
      class: "etag",
      rationale: "ETag stable across two HEAD requests; If-None-Match should yield 304.",
      etag: e1,
      contentLength: cl1 ?? undefined,
      lastModified: lm1 ?? undefined,
    };
  }

  if (cl1 && cl2 && cl1 === cl2) {
    const etagNote = e1 ? "ETag churns per request" : "no ETag";
    return {
      ...base,
      class: "content-length",
      rationale: `${etagNote}; Content-Length stable (${cl1} bytes). Misses same-size edits.`,
      contentLength: cl1,
      lastModified: lm1 ?? lm2 ?? undefined,
    };
  }

  // Last-Modified only — treat as etag-class (If-Modified-Since works)
  if (lm1 && lm2 && lm1 === lm2) {
    return {
      ...base,
      class: "etag",
      rationale: "No stable ETag/CL but Last-Modified stable; If-Modified-Since viable.",
      lastModified: lm1,
    };
  }

  // No usable HEAD validator — fall back to body hash
  const b1 = await bodyHash(row.url);
  if (!b1) {
    return {
      ...base,
      class: "unreliable",
      rationale: "HEAD had no stable validator and GET failed.",
    };
  }
  await sleep(BODY_GAP_MS);
  const b2 = await bodyHash(row.url);
  if (b1 === b2) {
    return {
      ...base,
      class: "body-hash",
      rationale: "HEAD returned no stable validator; GET body SHA-256 stable.",
    };
  }
  return {
    ...base,
    class: "unreliable",
    rationale:
      "No stable HEAD validator and body hash differs per request (SSR nonces or dynamic content).",
  };
}

function toMarkdown(probes: Probe[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const summary = probes.reduce<Record<QuirkClass, number>>(
    (acc, p) => {
      acc[p.class] = (acc[p.class] ?? 0) + 1;
      return acc;
    },
    { etag: 0, "content-length": 0, "body-hash": 0, unreliable: 0 },
  );

  const lines: string[] = [];
  lines.push(`# #515 — Change-detector classification`);
  lines.push("");
  lines.push(`Generated ${date} via \`bun scripts/probe-change-detectors.ts\`.`);
  lines.push("");
  lines.push(
    `Probed ${probes.length} stranded sources (\`type IN ('scrape','agent')\` with no \`feedUrl\`).`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Detector class | Count | What Phase 2 does with it |");
  lines.push("|---|---|---|");
  lines.push(
    `| \`etag\` | ${summary.etag} | HEAD with \`If-None-Match\` — expect 304 on unchanged content |`,
  );
  lines.push(
    `| \`content-length\` | ${summary["content-length"]} | HEAD, compare Content-Length. Misses same-size edits |`,
  );
  lines.push(
    `| \`body-hash\` | ${summary["body-hash"]} | GET + SHA-256. Works, pays full-body bandwidth |`,
  );
  lines.push(
    `| \`unreliable\` | ${summary.unreliable} | Phase 3 force-drain cron. Retier to \`low\` |`,
  );
  lines.push("");
  lines.push("## Per-source");
  lines.push("");
  lines.push("| Slug | Type | Class | Rationale |");
  lines.push("|---|---|---|---|");
  for (const p of probes) {
    const rationale = p.rationale.replace(/\|/g, "\\|");
    lines.push(`| \`${p.slug}\` | ${p.sourceType} | \`${p.class}\` | ${rationale} |`);
  }
  lines.push("");
  lines.push("## Observed validators");
  lines.push("");
  lines.push("| Slug | ETag | Last-Modified | Content-Length |");
  lines.push("|---|---|---|---|");
  for (const p of probes) {
    lines.push(
      `| \`${p.slug}\` | ${p.etag ? `\`${p.etag.slice(0, 32)}${p.etag.length > 32 ? "…" : ""}\`` : "—"} | ${p.lastModified ?? "—"} | ${p.contentLength ?? "—"} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const candidates = await listCandidates();
  log(`Classifying ${candidates.length} stranded source(s) via ${API_URL}...`);

  const probes: Probe[] = [];
  for (const row of candidates) {
    log(`  ${row.slug} (${row.type}) ← ${row.url}`);
    // oxlint-disable-next-line no-await-in-loop -- sequential: external HTTP probes, rate-limit friendly
    const p = await classify(row);
    log(`    → ${p.class} — ${p.rationale}`);
    probes.push(p);
  }

  const counts = probes.reduce<Record<string, number>>((acc, p) => {
    acc[p.class] = (acc[p.class] ?? 0) + 1;
    return acc;
  }, {});
  log("");
  log(
    `etag=${counts.etag ?? 0} · content-length=${counts["content-length"] ?? 0} · body-hash=${counts["body-hash"] ?? 0} · unreliable=${counts.unreliable ?? 0}`,
  );

  const reportPath = resolve(process.cwd(), ".context/515-change-detectors.md");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, toMarkdown(probes), "utf-8");
  log(`Report written to ${reportPath}`);

  if (jsonOut) {
    process.stdout.write(`${JSON.stringify({ probes, counts }, null, 2)}\n`);
  }
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
