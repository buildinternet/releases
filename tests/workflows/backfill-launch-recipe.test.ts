import { test, expect } from "bun:test";

// Guards the documented launch recipe in the backfilling-sources skill against the
// #1407 regression: project `.claude/workflows/` scripts are NOT name-registered in
// the Workflow registry (only plugin-shipped workflows like deep-research/code-review
// resolve by name), so the recipe — and the sweep's internal child call — must
// resolve by scriptPath, never by `Workflow({ name: ... })`. This is a static smoke
// check: it can't drive the harness end-to-end, but it fails the moment the recipe
// drifts back to the broken by-name form or points at a script that doesn't exist.

const SKILL = "src/agent/skills/backfilling-sources/SKILL.md";
const SWEEP = ".claude/workflows/backfill-sweep.ts";
const SOURCE = ".claude/workflows/backfill-source.ts";

async function read(path: string): Promise<string> {
  return await Bun.file(path).text();
}

// The "recipe" is the runnable code, not the surrounding prose — the skill is free
// to *mention* the broken `name:` form in a warning. Scope the checks to fenced
// ```js / ```ts code blocks so prose can't trip (or mask) the regression guards.
function codeBlocks(md: string): string {
  return [...md.matchAll(/```(?:js|ts|javascript|typescript)?\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join("\n");
}

test("skill launch recipe references scriptPaths that exist on disk", async () => {
  const code = codeBlocks(await read(SKILL));
  const paths = [...code.matchAll(/scriptPath:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  expect(paths.length).toBeGreaterThan(0);
  for (const p of paths) {
    expect(await Bun.file(p).exists(), `${SKILL} references missing scriptPath ${p}`).toBe(true);
  }
  // Both documented entry points are covered by the recipe.
  expect(paths).toContain(SOURCE);
  expect(paths).toContain(SWEEP);
});

test("skill launch recipe never launches a project workflow by registry name (#1407)", async () => {
  const code = codeBlocks(await read(SKILL));
  // `Workflow({ name: "backfill-source" | "backfill-sweep" })` is the broken form —
  // those names don't resolve in the Workflow registry. `[^}]*` keeps the match
  // inside one object literal and spans the recipe's newlines.
  const byName = /Workflow\(\s*\{[^}]*\bname:\s*["'`]backfill-(?:source|sweep)["'`]/;
  expect(byName.test(code), `${SKILL} recipe still launches a project workflow by name`).toBe(
    false,
  );
});

test("sweep resolves its child backfill-source by scriptPath, not by name (#1407)", async () => {
  const wf = await read(SWEEP);
  // The child must be launched via workflow({ scriptPath: ... }); a bare
  // workflow("backfill-source") alone would throw "not found".
  expect(
    /workflow\(\s*\{\s*scriptPath:/.test(wf),
    `${SWEEP} no longer resolves its child by scriptPath`,
  ).toBe(true);
  // The default child path is a real sibling script.
  const def = /BACKFILL_SCRIPT_PATH\s*=[\s\S]*?:\s*["'`]([^"'`]+)["'`]/.exec(wf);
  expect(def, `${SWEEP} missing BACKFILL_SCRIPT_PATH default`).not.toBeNull();
  if (def) {
    expect(await Bun.file(def[1]).exists(), `default child path ${def[1]} missing`).toBe(true);
  }
});
