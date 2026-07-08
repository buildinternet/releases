import { describe, it, expect } from "bun:test";
import { D1_MAX_BINDINGS, IN_ARRAY_CHUNK_SIZE } from "../../workers/api/src/lib/d1-limits.js";

// The product-scoped search path (`?product=` → `sourceIds`) inlines up to
// IN_ARRAY_CHUNK_SIZE source ids in an `IN (...)` list (see `sourceIdInList` in
// workers/api/src/queries/search.ts). The heaviest consumer, `searchReleasesFts`,
// carries these scalar binds alongside that list in a single prepared statement:
//
//   1  releases_fts MATCH <query>
//   1  s.org_id = <orgId>
//   1  COALESCE(s.kind, p.kind) = <kind>
//   1  r.published_at >= <since>
//   1  r.published_at <= <until>
//   1  LIMIT <limit>
//   1  OFFSET <offset>
//   ─
//   7  worst-case scalar binds outside the IN list
//
// This locks in that the IN-list ceiling leaves room for those binds under D1's
// 100-param cap. If a new scalar filter is added to the search path — or the
// chunk size is raised — this fails loudly rather than 500ing in prod on a
// max-scope query. The IN list caps rather than chunk-unions (a product owning
// >IN_ARRAY_CHUNK_SIZE sources is not a served shape), so the whole scope rides
// one statement and this single-statement budget is the real invariant.
const SEARCH_SCOPE_WORST_CASE_SCALAR_BINDS = 7;

describe("product-scoped search bind budget", () => {
  it(`IN_ARRAY_CHUNK_SIZE + worst-case scalar binds stays under D1's ${D1_MAX_BINDINGS}-bind cap`, () => {
    expect(IN_ARRAY_CHUNK_SIZE + SEARCH_SCOPE_WORST_CASE_SCALAR_BINDS).toBeLessThanOrEqual(
      D1_MAX_BINDINGS,
    );
  });
});
