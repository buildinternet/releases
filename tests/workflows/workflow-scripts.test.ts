import { test, expect } from "bun:test";

const SCRIPTS = [
  ".claude/workflows/backfill-source.ts",
  ".claude/workflows/backfill-sweep.ts",
  ".claude/workflows/update-overviews.ts",
];

// Each entry maps a workflow script to the helper module it inlines verbatim, and
// the exact set of helper names guarded against drift. A script may appear once
// per module it draws from; only the listed names are checked.
const INLINE_CHECKS = [
  {
    script: ".claude/workflows/backfill-source.ts",
    module: "tests/workflows/backfill-helpers.js",
    names: [
      "preflightDecision",
      "selectNewUrls",
      "applyCap",
      "budgetGate",
      "cleanVersion",
      "dedupeRecords",
      "chunk",
      "finalStatus",
      "summaryPath",
      "altitudeSanity",
    ],
  },
  {
    script: ".claude/workflows/backfill-sweep.ts",
    module: "tests/workflows/backfill-helpers.js",
    names: ["sweepReportPath"],
  },
  {
    script: ".claude/workflows/update-overviews.ts",
    module: "tests/workflows/overview-helpers.js",
    names: [
      "inferSelectionMode",
      "filterByDateWindow",
      "unescapeHtmlEntities",
      "extractOpener",
      "lintOverviewBody",
      "deriveCitationOffsets",
      "budgetGate",
    ],
  },
];

async function read(path: string): Promise<string> {
  return await Bun.file(path).text();
}

// Balanced-brace slice starting at the first "{" at/after the regex match.
function braceSlice(src: string, fromIndex: number): { text: string; start: number } {
  let i = src.indexOf("{", fromIndex);
  if (i < 0) throw new Error("no opening brace");
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return { text: src.slice(start, i), start };
}

// Extract a top-level `function NAME(...) { ... }` (optional leading `export `),
// signature+body, with `export ` stripped and whitespace normalized.
function extractFn(src: string, name: string): string | null {
  const re = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const { text, start } = braceSlice(src, m.index);
  const sig = src.slice(m.index, start).replace(/^export\s+/, "");
  return (sig + text).replace(/\s+/g, " ").trim();
}

// The `meta` object-literal substring. We assert on its TEXT — no eval, no execution.
function metaBlock(src: string): string {
  const m = /export\s+const\s+meta\s*=\s*\{/.exec(src);
  if (!m) throw new Error("no `export const meta`");
  return braceSlice(src, m.index).text;
}

// Parse-check the script as a workflow body WITHOUT executing it. Wrap it as the
// runtime does (async fn with the injected hooks, so top-level await/return are
// legal) and run it through Bun's transpiler — which lexes/parses and throws on
// syntax errors but never builds an executable Function or runs the code.
function assertParses(src: string): void {
  const body = src.replace(/export\s+const\s+meta/, "const meta");
  const wrapped = `async function __wf__(agent, parallel, pipeline, log, phase, budget, workflow, args) {\n${body}\n}`;
  new Bun.Transpiler({ loader: "ts" }).transformSync(wrapped); // throws on parse error
}

test.each(SCRIPTS)("%s parses as a workflow body", async (path) => {
  const src = await read(path);
  expect(() => assertParses(src)).not.toThrow();
});

test.each(SCRIPTS)("%s declares meta name/description/phases", async (path) => {
  const block = metaBlock(await read(path));
  expect(/name:\s*["'`]/.test(block)).toBe(true);
  expect(/description:\s*["'`]/.test(block)).toBe(true);
  expect(/phases:\s*\[/.test(block)).toBe(true);
});

test.each(SCRIPTS)("%s only calls phase() titles declared in meta.phases", async (path) => {
  const src = await read(path);
  const block = metaBlock(src);
  const declared = new Set([...block.matchAll(/title:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]));
  const called = [...src.matchAll(/phase\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
  for (const c of called) expect(declared.has(c)).toBe(true);
});

test.each(INLINE_CHECKS)("$script inlines $module verbatim", async ({ script, module, names }) => {
  const mod = await read(module);
  const wf = await read(script);
  for (const name of names) {
    const a = extractFn(mod, name);
    const b = extractFn(wf, name);
    expect(a, `${module} missing ${name}`).not.toBeNull();
    expect(b, `${script} missing inlined ${name}`).not.toBeNull();
    expect(b, `inlined ${name} drifted from ${module}`).toBe(a);
  }
});
