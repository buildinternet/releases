#!/usr/bin/env bun
// On-merge publish: push the CHANGELOG.md sections that changed in this push to
// the registry, then (re)generate their summary fields.
// Env: RELEASES_API_KEY (admin scope), BEFORE_SHA (github.event.before),
//      optional RELEASES_API_URL.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { planPublish } from "./changelog-md";

const SOURCE_ID = "src_LNrMz-rrFa2OD27mBUfaT";
const BASE = process.env.RELEASES_API_URL ?? "https://api.releases.sh";
const KEY = process.env.RELEASES_API_KEY;
const BEFORE_SHA = process.env.BEFORE_SHA;
if (!KEY) {
  console.error("RELEASES_API_KEY not set.");
  process.exit(1);
}

function gitShowFile(sha: string | undefined, path: string): string {
  if (!sha || /^0+$/.test(sha)) return ""; // no prior commit / first push
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], { encoding: "utf8" });
  } catch {
    return ""; // file did not exist in the before commit
  }
}

const beforeMd = gitShowFile(BEFORE_SHA, "CHANGELOG.md");
const afterMd = readFileSync("CHANGELOG.md", "utf8");
const plan = planPublish(beforeMd, afterMd);

if (plan.releases.length === 0) {
  console.log("No changed CHANGELOG.md sections; nothing to publish.");
  process.exit(0);
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`POST ${path} → HTTP ${res.status}: ${text}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : {};
}

// 1) Upsert content (idempotent on (source_id, url); clobbers edited bodies).
const batch = await post(`/v1/sources/${SOURCE_ID}/releases/batch`, {
  mode: "upsert-content",
  releases: plan.releases,
});
console.log("batch:", JSON.stringify(batch));

// 2) Resolve the pushed dates to release IDs.
const listRes = await fetch(`${BASE}/v1/sources/${SOURCE_ID}/releases?limit=100`, {
  headers: { Authorization: `Bearer ${KEY}` },
});
const list = (await listRes.json()) as { releases: { id: string; publishedAt: string }[] };
const idByDate = new Map<string, string>();
for (const r of list.releases ?? []) idByDate.set((r.publishedAt ?? "").slice(0, 10), r.id);

const ids = (dates: string[]) =>
  dates.map((d) => idByDate.get(d)).filter((x): x is string => Boolean(x));
const addedIds = ids(plan.added);
const modifiedIds = ids(plan.modified);

// 3) Summaries: fill for new days, regenerate for corrections.
if (addedIds.length) {
  await post(`/v1/workflows/generate-content`, {
    sourceId: SOURCE_ID,
    releaseIds: addedIds,
    regenerate: false,
    dryRun: false,
  });
}
if (modifiedIds.length) {
  await post(`/v1/workflows/generate-content`, {
    sourceId: SOURCE_ID,
    releaseIds: modifiedIds,
    regenerate: true,
    dryRun: false,
  });
}

console.log(`Published ${plan.added.length} added, ${plan.modified.length} modified.`);
