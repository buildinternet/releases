import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FLAGS } from "./flags.js";
import { FLAGS_DOC_BEGIN, FLAGS_DOC_END } from "./flags-docs.js";

const DOC = join(import.meta.dir, "..", "..", "..", "docs", "architecture", "feature-flags.md");
const ROLLOUT_HEADING = "#### Rollout gates";
const ROW = /^\|\s*`([a-z0-9-]+)`\s*\|\s*`(true|false)`\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/;

interface DocRow {
  default: string;
  reads: string;
  description: string;
  section: "kill-switch" | "rollout";
}

/** Parse the generated region of feature-flags.md into key → row metadata. */
function parseDocRows(): Map<string, DocRow> {
  const md = readFileSync(DOC, "utf8");
  const begin = md.indexOf(FLAGS_DOC_BEGIN);
  const end = md.indexOf(FLAGS_DOC_END);
  const region = md.slice(begin + FLAGS_DOC_BEGIN.length, end);
  const rolloutAt = region.indexOf(ROLLOUT_HEADING);

  const rows = new Map<string, DocRow>();
  for (const line of region.split("\n")) {
    const m = line.match(ROW);
    if (!m) continue;
    rows.set(m[1], {
      default: m[2],
      reads: m[3].trim(),
      description: m[4].trim(),
      section: region.indexOf(line) < rolloutAt ? "kill-switch" : "rollout",
    });
  }
  return rows;
}

describe("feature-flags.md flag table (drift guard)", () => {
  const rows = parseDocRows();

  it("lists every registry flag with matching default, reads, description, and kind grouping", () => {
    for (const def of Object.values(FLAGS)) {
      const row = rows.get(def.key);
      expect(
        row,
        `'${def.key}' missing from the generated table — run \`bun run flags:docs\``,
      ).toBeDefined();
      if (!row) continue;
      expect(row.default, `'${def.key}' default is stale — run \`bun run flags:docs\``).toBe(
        String(def.default),
      );
      expect(row.reads, `'${def.key}' reads is stale — run \`bun run flags:docs\``).toBe(
        def.reads.join(", "),
      );
      expect(
        row.description,
        `'${def.key}' description is stale — run \`bun run flags:docs\``,
      ).toBe(def.description.replace(/\|/g, "\\|"));
      expect(
        row.section,
        `'${def.key}' is in the wrong kind section — run \`bun run flags:docs\``,
      ).toBe(def.kind);
    }
  });

  it("has no orphan rows (every documented flag exists in the registry)", () => {
    const keys = new Set<string>(Object.values(FLAGS).map((d) => d.key));
    for (const key of rows.keys()) {
      expect(keys.has(key), `'${key}' is in the docs but not the FLAGS registry`).toBe(true);
    }
  });
});
