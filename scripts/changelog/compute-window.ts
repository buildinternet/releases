#!/usr/bin/env bun
// Resolve the draft window and emit GitHub Actions outputs: since, until, skip.
// Honors workflow_dispatch overrides via INPUT_SINCE / INPUT_UNTIL.
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { parseChangelog } from "./changelog-md";
import { computeDraftWindow } from "./draft-window";

function emit(out: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  const line =
    Object.entries(out)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  if (file) appendFileSync(file, line);
  console.log(line.trim());
}

const overrideSince = process.env.INPUT_SINCE?.trim();
const overrideUntil = process.env.INPUT_UNTIL?.trim();

if (overrideSince && overrideUntil) {
  emit({ since: overrideSince, until: overrideUntil, skip: "false" });
  process.exit(0);
}

const md = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "";
const sections = parseChangelog(md); // newest first
const latest = sections.length ? sections[0].dateIso : null;
const today = new Date().toISOString().slice(0, 10);
const w = computeDraftWindow(latest, today);

if (w.sinceIso > w.untilIso) {
  emit({ since: w.sinceIso, until: w.untilIso, skip: "true" }); // already caught up
} else {
  if (w.cappedFrom)
    console.log(`Window clamped; skipped days before ${w.sinceIso} (from ${w.cappedFrom}).`);
  emit({ since: w.sinceIso, until: w.untilIso, skip: "false" });
}
