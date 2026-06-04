import { test, expect } from "bun:test";
import { readdirSync } from "node:fs";

// Guards every skill's documented Workflow launch recipe against the #1407
// regression: project `.claude/workflows/*.ts` scripts are NOT registered in the
// Workflow name registry (only plugin-shipped workflows like deep-research/code-review
// resolve by name), so a skill must launch a project workflow by scriptPath, never by
// `Workflow({ name: ... })`. Static smoke check — it can't drive the harness
// end-to-end, but it fails the moment any skill's recipe points at a missing script
// or drifts (back) to launching a project workflow by name.

const SKILLS_DIR = "src/agent/skills";
const WORKFLOWS_DIR = ".claude/workflows";

async function read(path: string): Promise<string> {
  return await Bun.file(path).text();
}

// The "recipe" is the runnable code, not the surrounding prose — a skill is free to
// *mention* the broken `name:` form in a warning. Return only js/ts fenced blocks.
// Pairing is done over ALL fences (any language) so a sql/bash block elsewhere can't
// mis-pair the openers/closers and slurp prose into a "code block".
function codeBlocks(md: string): string {
  const jsLangs = new Set(["", "js", "ts", "javascript", "typescript"]);
  return [...md.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)]
    .filter((m) => jsLangs.has(m[1].trim().toLowerCase()))
    .map((m) => m[2])
    .join("\n");
}

// Names of the project workflows in `.claude/workflows/` (basename, no extension) —
// exactly the ones that DON'T resolve by registry name.
const projectWorkflowNames = readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.replace(/\.ts$/, ""));

const skillFiles = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `${SKILLS_DIR}/${d.name}/SKILL.md`);

test("at least one project workflow exists and at least one skill launches one", async () => {
  expect(projectWorkflowNames.length).toBeGreaterThan(0);
  let launchers = 0;
  for (const f of skillFiles) {
    if (!(await Bun.file(f).exists())) continue;
    if (/Workflow\(\s*\{/.test(codeBlocks(await read(f)))) launchers++;
  }
  expect(launchers).toBeGreaterThan(0);
});

test("every skill recipe references scriptPaths that exist on disk", async () => {
  for (const f of skillFiles) {
    if (!(await Bun.file(f).exists())) continue;
    const code = codeBlocks(await read(f));
    const paths = [...code.matchAll(/scriptPath:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    for (const p of paths) {
      expect(await Bun.file(p).exists(), `${f} references missing scriptPath ${p}`).toBe(true);
    }
  }
});

test("no skill launches a project workflow by registry name (#1407)", async () => {
  // `Workflow({ ... name: "<project-workflow>" ... })` is the broken form. A skill
  // may still launch a plugin/built-in workflow (e.g. deep-research) by name — only
  // names that match a file in `.claude/workflows/` are the regression.
  const launchNames = (code: string) =>
    [...code.matchAll(/Workflow\(\s*\{[^}]*\bname:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  for (const f of skillFiles) {
    if (!(await Bun.file(f).exists())) continue;
    for (const name of launchNames(codeBlocks(await read(f)))) {
      expect(
        projectWorkflowNames.includes(name),
        `${f} launches project workflow "${name}" by name — use scriptPath (#1407)`,
      ).toBe(false);
    }
  }
});

test("sweep resolves its child backfill-source by scriptPath, not by name (#1407)", async () => {
  const wf = await read(`${WORKFLOWS_DIR}/backfill-sweep.ts`);
  // The child must be launched via workflow({ scriptPath: ... }); a bare
  // workflow("backfill-source") alone would throw "not found".
  expect(
    /workflow\(\s*\{\s*scriptPath:/.test(wf),
    "backfill-sweep.ts no longer resolves its child by scriptPath",
  ).toBe(true);
  // The default child path is a real sibling script.
  const def = /BACKFILL_SCRIPT_PATH\s*=[\s\S]*?:\s*["'`]([^"'`]+)["'`]/.exec(wf);
  expect(def, "backfill-sweep.ts missing BACKFILL_SCRIPT_PATH default").not.toBeNull();
  if (def) {
    expect(await Bun.file(def[1]).exists(), `default child path ${def[1]} missing`).toBe(true);
  }
});
