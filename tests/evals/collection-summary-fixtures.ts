/**
 * Collection daily-summary eval fixtures: the fixture shape, loader, and the
 * canonical rubric path. Each fixture is one JSON file under
 * fixtures/collection-summaries/ carrying a real CollectionDayInput captured
 * from the prod backfill (a busy multi-org day, a quiet trivial bump, an
 * SDK-noise day, a one-big-ship day), so the eval grades on real day-windows.
 */
import { readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import type { CollectionDayInput } from "@releases/ai-internal/collection-summary";

export interface CollectionFixture {
  name: string;
  input: CollectionDayInput;
}

export function collectionSummaryFixturesDir(): string {
  return join(import.meta.dir, "fixtures", "collection-summaries");
}

/** Absolute path to the Tier-2 grading rubric. */
export function collectionSummaryRubricPath(): string {
  return join(
    import.meta.dir,
    "..",
    "..",
    "managed-agents",
    "src",
    "shared",
    "rubrics",
    "collection-summary.md",
  );
}

export function loadCollectionSummaryFixtures(
  dir: string = collectionSummaryFixturesDir(),
): CollectionFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as Omit<
        CollectionFixture,
        "name"
      >;
      return { name: basename(f, ".json"), ...parsed };
    });
}
