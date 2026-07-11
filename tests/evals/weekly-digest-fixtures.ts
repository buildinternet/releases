/**
 * Weekly-digest eval fixtures: the fixture shape, loader, and the canonical
 * rubric path. Each fixture is one JSON file under fixtures/weekly-digests/
 * carrying a real `CollectionWeekInput` (full, unselected release list for
 * one ET calendar week) captured read-only from prod D1 via the same
 * visibility joins as `getCollectionWeekReleases`
 * (workers/api/src/queries/collection-summaries.ts) — see
 * `.context/2026-07-11-seo-ws3-digest-model-eval.md` for the capture query
 * and the six chosen (collection, week) cells.
 *
 * The digest module's own `selectWeeklyDigestReleases` runs the
 * importance-biased cap/selection at generation time (inside
 * `generateCollectionWeeklyDigest`) — fixtures intentionally carry the full
 * unselected list so the eval exercises that selection logic for real,
 * rather than hand-rolling a second selection here.
 */
import { readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import type { CollectionWeekInput } from "@releases/ai-internal/collection-weekly-digest";

export interface WeeklyDigestFixture {
  name: string;
  input: CollectionWeekInput;
}

export function weeklyDigestFixturesDir(): string {
  return join(import.meta.dir, "fixtures", "weekly-digests");
}

/** Absolute path to the Tier-2 grading rubric. */
export function weeklyDigestRubricPath(): string {
  return join(
    import.meta.dir,
    "..",
    "..",
    "managed-agents",
    "src",
    "shared",
    "rubrics",
    "weekly-digest.md",
  );
}

export function loadWeeklyDigestFixtures(
  dir: string = weeklyDigestFixturesDir(),
): WeeklyDigestFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as Omit<
        WeeklyDigestFixture,
        "name"
      >;
      return { name: basename(f, ".json"), ...parsed };
    });
}
