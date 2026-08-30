import path from "node:path";
import { describe, expect, it } from "bun:test";

// The docs manifest this route pulls sections from resolves markdown content
// relative to `process.cwd()` (`web/src/content/...`) once, at module-load
// time — which only holds when the process cwd is `web/` (true for `next
// dev`/`next build`, and for `bun test` invoked from inside `web/`, but not
// for the root multi-dir `bun test tests/ web/ ...` invocation). Pin the cwd
// just long enough to import the route module, then restore it, so this test
// resolves content correctly regardless of where the runner was launched
// from without disturbing cwd-sensitive tests elsewhere in the same process.
const originalCwd = process.cwd();
if (path.basename(originalCwd) !== "web") process.chdir(path.join(originalCwd, "web"));
const { GET } = await import("./route.js");
if (process.cwd() !== originalCwd) process.chdir(originalCwd);

describe("GET /llms.txt", () => {
  it("serves the site map with a When to use section", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("## When to use Releases");
    expect(body).toContain(
      "Research roadmap and product-development opportunities: survey what the rest of the ecosystem is shipping as input for deciding what to build next.",
    );
  });
});
