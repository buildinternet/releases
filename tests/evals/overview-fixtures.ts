/**
 * Shared overview-eval fixtures: the fixture shape, loader, and canonical paths,
 * used by both the metered eval (overview.eval.ts) and the key-free sub-agent
 * path (subagent-runner.ts) so the two can't drift.
 *
 * Each fixture is one JSON file under fixtures/overviews/ carrying the
 * OverviewRequestInput the production overview-regen workflow would build, plus
 * optional per-fixture grading knobs.
 */
import { readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import type { OverviewRequestInput } from "@releases/ai-internal/overview-content";
import type { OverviewStructuralSpec, CitationGradeSpec } from "./graders";

export interface OverviewFixture {
  name: string;
  input: OverviewRequestInput;
  /** Structural knobs; orgName is always taken from input.org.name. */
  structural?: Omit<OverviewStructuralSpec, "orgName">;
  /** Citation knobs — metered path only (sub-agents emit no native citations). */
  citations?: CitationGradeSpec;
}

export function overviewFixturesDir(): string {
  return join(import.meta.dir, "fixtures", "overviews");
}

/** Absolute path to the Tier-2 grading rubric. */
export function overviewRubricPath(): string {
  return join(import.meta.dir, "..", "..", "src", "shared", "rubrics", "overview.md");
}

export function loadOverviewFixtures(dir: string = overviewFixturesDir()): OverviewFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as Omit<
        OverviewFixture,
        "name"
      >;
      return { name: basename(f, ".json"), ...parsed };
    });
}
