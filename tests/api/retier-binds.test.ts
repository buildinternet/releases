import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
// Import from the local workspace package directly so the test sees
// `medianGapDays` / `lastRetieredAt`; the published @buildinternet copy
// in node_modules is still on v0.13.2 until the next release cuts.
import { sources } from "../../packages/core/src/schema";
import { D1_MAX_BINDINGS } from "../../workers/api/src/lib/d1-limits.js";

// The daily retier issues one UPDATE per source. Each statement binds the
// new cadence columns plus, when a tier moves, fetchPriority — and the id
// in the WHERE clause. These assertions lock in that the per-statement
// bind count is nowhere near D1's 100-bind cap, so the pattern can't
// regress into the same failure mode as #318 if extra columns are added
// to the retier later.

const db = drizzle(new Database(":memory:"));

describe("retier UPDATE bind budget", () => {
  it("cadence-only update binds 3 params (medianGapDays, lastRetieredAt, id)", () => {
    const q = db
      .update(sources)
      .set({ medianGapDays: 4.5, lastRetieredAt: "2026-04-18T03:00:00Z" })
      .where(eq(sources.id, "src_x"))
      .toSQL();
    expect(q.params.length).toBe(3);
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
  });

  it("cadence + tier update binds 4 params (adds fetchPriority)", () => {
    const q = db
      .update(sources)
      .set({
        medianGapDays: 4.5,
        lastRetieredAt: "2026-04-18T03:00:00Z",
        fetchPriority: "normal",
      })
      .where(eq(sources.id, "src_x"))
      .toSQL();
    expect(q.params.length).toBe(4);
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
  });
});
