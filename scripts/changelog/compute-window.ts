#!/usr/bin/env bun
// Resolve the draft window and emit GitHub Actions outputs:
//   since, until  — Eastern (America/New_York) calendar days, inclusive
//   skip          — "true" when already caught up
//   search_start, search_end — UTC instants bounding the gh search (one extra
//                   day before `since` as an overlap guard for the prior day)
//   day_bounds    — JSON [{day, startUtc, endUtc}] mapping each ET day to its
//                   UTC range so the agent buckets PRs by mergedAt
// Honors workflow_dispatch overrides via INPUT_SINCE / INPUT_UNTIL.
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { parseChangelog } from "./changelog-md";
import { addDays, computeDraftWindow } from "./draft-window";
import { etDayOf, etMidnightUtc } from "./et-dates";

function emit(out: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  const line =
    Object.entries(out)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  if (file) appendFileSync(file, line);
  console.log(line.trim());
}

// UTC search bounds + per-ET-day bucketing ranges for [since..until], padded
// one day back so the draft can self-heal the previous (already-drafted) day.
function searchOutputs(sinceIso: string, untilIso: string): Record<string, string> {
  const padSince = addDays(sinceIso, -1);
  const bounds: { day: string; startUtc: string; endUtc: string }[] = [];
  for (let d = padSince; d <= untilIso; d = addDays(d, 1)) {
    bounds.push({ day: d, startUtc: etMidnightUtc(d), endUtc: etMidnightUtc(addDays(d, 1)) });
  }
  return {
    search_start: etMidnightUtc(padSince),
    search_end: etMidnightUtc(addDays(untilIso, 1)),
    day_bounds: JSON.stringify(bounds),
  };
}

const overrideSince = process.env.INPUT_SINCE?.trim();
const overrideUntil = process.env.INPUT_UNTIL?.trim();

if (overrideSince && overrideUntil) {
  emit({
    since: overrideSince,
    until: overrideUntil,
    skip: "false",
    ...searchOutputs(overrideSince, overrideUntil),
  });
  process.exit(0);
}

const md = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "";
const sections = parseChangelog(md); // newest first
const latest = sections.length ? sections[0].dateIso : null;
const today = etDayOf(Date.now());
const w = computeDraftWindow(latest, today);

if (w.sinceIso > w.untilIso) {
  emit({ since: w.sinceIso, until: w.untilIso, skip: "true" }); // already caught up
} else {
  if (w.cappedFrom)
    console.log(`Window clamped; skipped days before ${w.sinceIso} (from ${w.cappedFrom}).`);
  emit({
    since: w.sinceIso,
    until: w.untilIso,
    skip: "false",
    ...searchOutputs(w.sinceIso, w.untilIso),
  });
}
