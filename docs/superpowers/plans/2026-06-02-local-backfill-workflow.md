# Local Backfill Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, deterministic dynamic Workflow that backfills a changelog source's full history (per-source engine + sequential sweep wrapper + front-door skill), wrapping the `local-ingest` primitives so the window cap, budget gate, preflight, and dedup live in tested JS instead of fragile prose — no managed-agent inference bill.

**Architecture:** A Workflow script body has no Bash/filesystem/`fetch` — it is pure JS orchestration, and every concrete action is an `agent()` call returning a forced schema. Workflow scripts are also self-contained (no imports). So the deterministic decision logic is developed and unit-tested as a standalone module (`tests/workflows/backfill-helpers.js`) and **inlined verbatim** into `backfill-source.ts`; a drift-guard test keeps the copies identical. The orchestration glue (phase wiring, agent prompts) is verified structurally (parse + `meta` validation) plus a final manual behavioral smoke that spends real tokens.

**Tech Stack:** Bun, TypeScript, `bun test`. The Claude Code Workflow tool (`agent()`/`parallel()`/`workflow()`/`budget`/`phase()`/`log()`). The `releases` CLI (`RELEASES_API_*` autoloaded from project `.env`). The `/v1/sources/:slug/releases/batch` idempotent upsert. `src/agent/skills/local-ingest/preflight.ts`.

---

## Testing philosophy (read first)

TDD applies cleanly to the **pure decision logic** (Task 1) — `bun test` red-green-refactor. It does **not** apply to the workflow scripts as unit tests: they reference runtime globals (`agent`, `budget`, top-level `await`/`return`) that only exist inside the Workflow runtime, so they can't be imported. Those are covered two ways: (a) a **structural test** (Task 2) that parse-checks each script, validates its `meta`, and guards the inlined-helper copies against drift; (b) a **manual behavioral smoke** (Task 7) — dry-run, the Conductor refusal regression, and a small live run — which is the only thing that exercises real agents and therefore must be operator-run (it spends tokens).

## File structure

```
tests/workflows/backfill-helpers.js          ← CREATE: pure decision logic (source of truth, untyped JS + JSDoc)
tests/workflows/backfill-helpers.test.ts      ← CREATE: unit tests for the above (real TDD)
tests/workflows/workflow-scripts.test.ts      ← CREATE: parse + meta + phase + helper-drift guard for both scripts
.claude/workflows/backfill-source.ts          ← CREATE: per-source engine (inlines the helpers)
.claude/workflows/backfill-sweep.ts           ← CREATE: sequential multi-source wrapper
src/agent/skills/backfilling-sources/SKILL.md ← CREATE: front-door skill
AGENTS.md                                      ← MODIFY: one-line Conventions pointer
docs/architecture/local-ingest.md             ← MODIFY: cross-link the backfill workflow
```

No `tsconfig` change: `.claude/workflows/*.ts` are runtime scripts, not part of the typed build (they use injected globals). The helper module is plain `.js` so its function bodies are byte-identical to the inlined copies.

---

## Task 1: Pure decision-logic module + unit tests

**Files:**

- Create: `tests/workflows/backfill-helpers.js`
- Test: `tests/workflows/backfill-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/workflows/backfill-helpers.test.ts`:

```ts
import { test, expect } from "bun:test";
import {
  preflightDecision,
  selectNewUrls,
  applyCap,
  budgetGate,
  cleanVersion,
  dedupeRecords,
  chunk,
  finalStatus,
} from "./backfill-helpers.js";

test("preflightDecision: proceed/refuse/unknown-with-retry", () => {
  expect(preflightDecision("proceed", 1)).toEqual({ action: "proceed" });
  expect(preflightDecision("refuse", 1)).toEqual({ action: "stop", status: "refused" });
  expect(preflightDecision("unknown", 1)).toEqual({ action: "retry" });
  expect(preflightDecision("unknown", 2)).toEqual({ action: "stop", status: "blocked-unknown" });
});

test("selectNewUrls: drops already-ingested and intra-list dupes, preserves order", () => {
  const r = selectNewUrls(["a", "b", "a", "c"], ["b"]);
  expect(r.fresh).toEqual(["a", "c"]);
  expect(r.skippedKnown).toBe(1);
});

test("applyCap: caps and reports skipped with a log line", () => {
  const r = applyCap(["a", "b", "c"], 2);
  expect(r.targets).toEqual(["a", "b"]);
  expect(r.capped).toBe(2);
  expect(r.deferred).toBe(1);
  expect(r.logLine).toContain("skipping 1");
  const none = applyCap(["a"], 50);
  expect(none.deferred).toBe(0);
  expect(none.logLine).toContain("within cap");
});

test("budgetGate: no ceiling never stops; stops under reserve", () => {
  expect(budgetGate(null, 0, 1000, 0, 10)).toEqual({ stop: false });
  expect(budgetGate(500000, 999999, 60000, 8, 40).stop).toBe(false);
  const g = budgetGate(500000, 100, 60000, 8, 40);
  expect(g.stop).toBe(true);
  expect(g.logLine).toContain("32 pages deferred");
});

test("cleanVersion: strips placeholders, trims, keeps real versions", () => {
  expect(cleanVersion("<UNKNOWN>")).toBeUndefined();
  expect(cleanVersion("n/a")).toBeUndefined();
  expect(cleanVersion("  ")).toBeUndefined();
  expect(cleanVersion(null)).toBeUndefined();
  expect(cleanVersion(" 1.4.0 ")).toBe("1.4.0");
});

test("dedupeRecords: dedups by url, drops missing fields, cleans version", () => {
  const { kept, dropped, reasons } = dedupeRecords([
    { url: "u1", title: "T", content: "C", version: "<UNKNOWN>" },
    { url: "u1", title: "T2", content: "C2" }, // dup url
    { url: "u2", title: "", content: "C" }, // missing title
    { title: "T3", content: "C3" }, // missing url
    { url: "u3", title: "T3", content: "C3", version: "2.0" },
  ]);
  expect(kept.map((r) => r.url)).toEqual(["u1", "u3"]);
  expect(kept[0].version).toBeUndefined();
  expect(kept[1].version).toBe("2.0");
  expect(dropped).toBe(3);
  expect(reasons).toEqual({ missingUrl: 1, missingTitleOrContent: 1, duplicate: 1 });
});

test("chunk: splits into bounded groups", () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunk([], 2)).toEqual([]);
});

test("finalStatus: partial-budget when anything deferred", () => {
  expect(finalStatus(0)).toBe("completed");
  expect(finalStatus(3)).toBe("partial-budget");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/workflows/backfill-helpers.test.ts`
Expected: FAIL — `Cannot find module './backfill-helpers.js'`.

- [ ] **Step 3: Write the module**

`tests/workflows/backfill-helpers.js` (untyped JS + JSDoc — function bodies must stay byte-identical to the copies inlined in `backfill-source.ts`):

```js
// Source-of-truth for the deterministic decision logic that backfill-source.ts
// INLINES verbatim (Workflow scripts can't import). Unit-tested here;
// tests/workflows/workflow-scripts.test.ts guards the inlined copies against drift.
// Keep this annotation-free so the bodies match the inlined plain-JS copies.

/**
 * @param {"proceed"|"refuse"|"unknown"} verdict
 * @param {number} attempt 1 on first check, 2 after one retry
 * @returns {{action:"proceed"|"retry"|"stop", status?:string}}
 */
export function preflightDecision(verdict, attempt) {
  if (verdict === "proceed") return { action: "proceed" };
  if (verdict === "refuse") return { action: "stop", status: "refused" };
  if (attempt < 2) return { action: "retry" };
  return { action: "stop", status: "blocked-unknown" };
}

/**
 * @param {string[]} discovered
 * @param {string[]} known
 * @returns {{fresh:string[], skippedKnown:number}}
 */
export function selectNewUrls(discovered, known) {
  const knownSet = new Set(known);
  const freshSet = new Set();
  const knownHits = new Set();
  for (const u of discovered) {
    if (knownSet.has(u)) knownHits.add(u);
    else freshSet.add(u);
  }
  return { fresh: [...freshSet], skippedKnown: knownHits.size };
}

/**
 * @param {string[]} fresh newest-first
 * @param {number} maxReleases
 * @returns {{targets:string[], capped:number, deferred:number, logLine:string}}
 */
export function applyCap(fresh, maxReleases) {
  const targets = fresh.slice(0, maxReleases);
  const deferred = fresh.length - targets.length;
  const logLine =
    deferred > 0
      ? `mapped ${fresh.length} new pages; capping to ${targets.length} (maxReleases=${maxReleases}); skipping ${deferred} older — re-run with a higher cap to go deeper`
      : `mapped ${fresh.length} new pages; all within cap (maxReleases=${maxReleases})`;
  return { targets, capped: targets.length, deferred, logLine };
}

/**
 * @param {number|null} total budget.total (null = no ceiling)
 * @param {number} remaining budget.remaining()
 * @param {number} reserve per-wave token reserve
 * @param {number} done pages extracted so far
 * @param {number} totalTargets
 * @returns {{stop:boolean, logLine?:string}}
 */
export function budgetGate(total, remaining, reserve, done, totalTargets) {
  if (!total) return { stop: false };
  if (remaining >= reserve) return { stop: false };
  const deferred = totalTargets - done;
  return {
    stop: true,
    logLine: `budget gate: ${remaining} tokens left (< ${reserve} reserve); stopping at ${done}/${totalTargets}, ${deferred} pages deferred — re-run to continue (idempotent)`,
  };
}

/**
 * @param {string|null|undefined} v
 * @returns {string|undefined}
 */
export function cleanVersion(v) {
  if (v == null) return undefined;
  const t = String(v).trim();
  if (!t) return undefined;
  const lower = t.toLowerCase();
  if (
    lower === "<unknown>" ||
    lower === "unknown" ||
    lower === "n/a" ||
    lower === "na" ||
    lower === "none"
  )
    return undefined;
  return t;
}

/**
 * @param {Array<object>} records
 * @returns {{kept:Array<object>, dropped:number, reasons:{missingUrl:number,missingTitleOrContent:number,duplicate:number}}}
 */
export function dedupeRecords(records) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  const reasons = { missingUrl: 0, missingTitleOrContent: 0, duplicate: 0 };
  for (const r of records || []) {
    if (!r || !r.url) {
      dropped++;
      reasons.missingUrl++;
      continue;
    }
    if (!r.title || !r.content) {
      dropped++;
      reasons.missingTitleOrContent++;
      continue;
    }
    if (seen.has(r.url)) {
      dropped++;
      reasons.duplicate++;
      continue;
    }
    seen.add(r.url);
    const v = cleanVersion(r.version);
    const out = { ...r };
    if (v === undefined) delete out.version;
    else out.version = v;
    kept.push(out);
  }
  return { kept, dropped, reasons };
}

/**
 * @param {Array<any>} arr
 * @param {number} size
 * @returns {Array<Array<any>>}
 */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {number} deferredForBudget
 * @returns {"completed"|"partial-budget"}
 */
export function finalStatus(deferredForBudget) {
  return deferredForBudget > 0 ? "partial-budget" : "completed";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/workflows/backfill-helpers.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/workflows/backfill-helpers.js tests/workflows/backfill-helpers.test.ts
git commit -m "feat(backfill): deterministic decision-logic module + unit tests"
```

---

## Task 2: Structural test for workflow scripts (red first)

**Files:**

- Test: `tests/workflows/workflow-scripts.test.ts`

This test is written **before** the scripts exist, so it starts red. It parse-checks each workflow file, validates its `meta` literal, checks every `phase('X')` title is declared in `meta.phases`, and guards the helper functions inlined into `backfill-source.ts` against the source-of-truth module.

- [ ] **Step 1: Write the failing test**

`tests/workflows/workflow-scripts.test.ts`:

```ts
import { test, expect } from "bun:test";

const SCRIPTS = [".claude/workflows/backfill-source.ts", ".claude/workflows/backfill-sweep.ts"];
const HELPER_NAMES = [
  "preflightDecision",
  "selectNewUrls",
  "applyCap",
  "budgetGate",
  "cleanVersion",
  "dedupeRecords",
  "chunk",
  "finalStatus",
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

test("backfill-source.ts inlines the helper module verbatim", async () => {
  const mod = await read("tests/workflows/backfill-helpers.js");
  const wf = await read(".claude/workflows/backfill-source.ts");
  for (const name of HELPER_NAMES) {
    const a = extractFn(mod, name);
    const b = extractFn(wf, name);
    expect(a, `module missing ${name}`).not.toBeNull();
    expect(b, `backfill-source.ts missing inlined ${name}`).not.toBeNull();
    expect(b, `inlined ${name} drifted from module`).toBe(a);
  }
});
```

> **No `new Function` / `eval`.** The parse-check uses `Bun.Transpiler.transformSync`, which only lexes/parses (it throws on syntax errors but never executes), and `meta` is validated as text — so file contents are never turned into runnable code. Avoids the code-injection shape flagged by the security guidance.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/workflows/workflow-scripts.test.ts`
Expected: FAIL — files `.claude/workflows/backfill-source.ts` / `backfill-sweep.ts` don't exist yet (read rejects). This is the expected red state; it goes green after Tasks 3–4.

- [ ] **Step 3: Commit the test**

```bash
git add tests/workflows/workflow-scripts.test.ts
git commit -m "test(backfill): structural guard for workflow scripts (red until scripts land)"
```

---

## Task 3: `backfill-source.ts` — the per-source engine

**Files:**

- Create: `.claude/workflows/backfill-source.ts`

Build the script section by section. Each step appends to the file; the structural test (Task 2) is the gate at the end.

- [ ] **Step 1: meta + tunables + inlined helpers**

Create `.claude/workflows/backfill-source.ts` starting with:

```js
export const meta = {
  name: "backfill-source",
  description:
    "Local full-history backfill of one changelog source: preflight-gated, window-capped, budget-gated index→detail extraction written via the idempotent /batch upsert — no managed-agent inference bill.",
  whenToUse:
    "Backfill a source's changelog history locally without the managed-agent extraction bill. Dry-run first (the default). Launch via the backfilling-sources skill.",
  phases: [
    { title: "Preflight", detail: "robots/Content-Signal gate (fail-closed) + run setup" },
    { title: "Map", detail: "enumerate detail URLs, diff against ingested, cap" },
    { title: "Extract", detail: "agent-per-page records (Sonnet), budget-gated waves" },
    { title: "Write", detail: "chunked /batch upsert (Haiku)" },
    { title: "Report", detail: "validate + run summary to ~/.releases/work" },
  ],
};

// ── Tunables ──────────────────────────────────────────────────────────────
const WAVE = 8; // pages extracted concurrently per budget-checked wave
const PER_WAVE_RESERVE = 60000; // stop scheduling a new wave when budget.remaining() drops below this
const CHUNK_SIZE = 50; // records per /batch POST

// ── Inlined deterministic helpers ──────────────────────────────────────────
// MIRRORED VERBATIM from tests/workflows/backfill-helpers.js (Workflow scripts
// can't import). Unit-tested there; workflow-scripts.test.ts guards drift.
// Do not edit here without editing the module — the drift guard will fail.
```

Then paste the eight helper functions **exactly** as they appear in `tests/workflows/backfill-helpers.js`, but with the leading `export ` removed from each (plain `function ...`). The drift guard normalizes the `export` prefix, so only the signature+body must match. (Copy `preflightDecision`, `selectNewUrls`, `applyCap`, `budgetGate`, `cleanVersion`, `dedupeRecords`, `chunk`, `finalStatus`.)

- [ ] **Step 2: schemas + small local helpers + args**

Append:

```js
// ── Schemas (forced structured output) ──────────────────────────────────────
const PREFLIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["proceed", "refuse", "unknown"] },
    sitemaps: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["verdict"],
};
const MAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    structure: { type: "string", enum: ["single-page", "index", "unknown"] },
    pages: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
  required: ["structure", "pages"],
};
const RECORDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pageUrl: { type: "string" },
    records: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: ["string", "null"] },
          title: { type: "string" },
          content: { type: "string" },
          url: { type: "string" },
          publishedAt: { type: ["string", "null"] },
          media: { type: ["string", "null"] },
          type: { type: ["string", "null"], enum: ["feature", "rollup", null] },
          prerelease: { type: ["boolean", "null"] },
        },
        required: ["title", "content", "url"],
      },
    },
  },
  required: ["pageUrl", "records"],
};
const WRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    written: { type: "number" },
    chunks: { type: "number" },
    errors: { type: "array", items: { type: "string" } },
  },
  required: ["written"],
};
const VALIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    count: { type: "number" },
    emptyContent: { type: "number" },
    sampleTitles: { type: "array", items: { type: "string" } },
  },
  required: ["count"],
};

// ── Local label/prompt helpers (not shared; fine to keep here) ───────────────
function short(u) {
  try {
    const p = new URL(u).pathname.split("/").filter(Boolean).pop();
    return (p || u).slice(0, 40);
  } catch {
    return String(u).slice(0, 40);
  }
}
function extractPrompt(url, singlePage) {
  return `Fetch ${url} and extract ${singlePage ? "EVERY changelog entry on the page" : "the release(s) on this page"} as records for the Releases /batch upsert.
Per record: { version?, title (required), content (required, markdown), url (REQUIRED — stable per-release URL; for a single-page changelog use ${url}#<slug-anchor>), publishedAt? (ISO-8601; approximate a month/quarter/year heading to a date rather than omit), media? (UNWRAP _next/image and Vercel optimizer wrappers to the underlying CDN URL), type? ("feature"|"rollup"), prerelease? }.
Rules: ALWAYS populate url (the dedup key). Never invent a version — omit if absent. Return { pageUrl: "${url}", records: [...] }.`;
}

// ── args ─────────────────────────────────────────────────────────────────────
let input = args;
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch {
    /* report below */
  }
}
input = input || {};
const SOURCE = input.source;
const MAX = Number.isFinite(input.maxReleases) ? input.maxReleases : 50;
const DRY = input.dryRun !== false; // default true
const EXTRACT_MODEL = input.model === "haiku" ? "haiku" : "sonnet";
if (!SOURCE) {
  log("backfill-source: missing required `source` arg");
  return { status: "error", error: "missing source" };
}
const slugForDir = String(SOURCE)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");
```

- [ ] **Step 3: Preflight phase (fail-closed) + run setup**

Append:

```js
// ── Phase: Preflight ─────────────────────────────────────────────────────────
phase("Preflight");
const resolved = await agent(
  `Resolve the Releases source "${SOURCE}". Run \`releases admin source get ${SOURCE} --json\` (it may be a slug, src_ id, or http(s) URL — if already a URL, use it directly and still resolve the slug). Return the canonical human URL, the source slug, and org slug.`,
  {
    label: "resolve-source",
    phase: "Preflight",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
        slug: { type: "string" },
        org: { type: ["string", "null"] },
      },
      required: ["url", "slug"],
    },
  },
);
if (!resolved || !resolved.url || !resolved.slug) {
  log("preflight: could not resolve source");
  return { status: "error", error: "unresolved source" };
}

let verdict = "unknown",
  sitemaps = [],
  attempt = 0,
  decision;
do {
  attempt++;
  const pf = await agent(
    `Run the local-ingest opt-out preflight and report its verdict EXACTLY.
Command: \`bun src/agent/skills/local-ingest/preflight.ts ${resolved.url} --json\`
Exit 0 → "proceed", exit 1 → "refuse", exit 2 → "unknown". Return the verdict, the sitemaps array it prints, and a one-line reason.`,
    { label: `preflight#${attempt}`, phase: "Preflight", model: "haiku", schema: PREFLIGHT_SCHEMA },
  );
  verdict = (pf && pf.verdict) || "unknown";
  if (pf && Array.isArray(pf.sitemaps)) sitemaps = pf.sitemaps;
  decision = preflightDecision(verdict, attempt);
} while (decision.action === "retry");
if (decision.action === "stop") {
  log(`preflight: ${verdict} → ${decision.status}; not fetching or writing.`);
  return { status: decision.status, source: SOURCE, url: resolved.url };
}

const runInfo = await agent(
  `Set up the maintenance run for this backfill.
1. Run \`releases admin work status --json\`.
2. If a run is active, capture its run dir, started=false.
3. If none, run \`releases admin work start backfill-${slugForDir} --json\`, capture the new run dir, started=true, and \`mkdir -p ~/.releases/work/tasks ~/.releases/work/reports\`.
Return the absolute run dir and whether you started it.`,
  {
    label: "run-setup",
    phase: "Preflight",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { runDir: { type: "string" }, started: { type: "boolean" } },
      required: ["runDir", "started"],
    },
  },
);
const RUN_DIR = (runInfo && runInfo.runDir) || null;
const WE_STARTED_RUN = !!(runInfo && runInfo.started);
```

- [ ] **Step 4: Map phase + dry-run exit**

Append:

```js
// ── Phase: Map ───────────────────────────────────────────────────────────────
phase("Map");
const known = await agent(
  `List the release URLs already ingested for source "${resolved.slug}" so we skip them. Run \`releases tail ${resolved.slug} --json\` and return the array of release \`url\` values (\`[]\` if none).`,
  {
    label: "known-urls",
    phase: "Map",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { urls: { type: "array", items: { type: "string" } } },
      required: ["urls"],
    },
  },
);
const knownUrls = (known && known.urls) || [];

const mapped = await agent(
  `Map the changelog at ${resolved.url} into per-release detail-page URLs.
1. Classify shape: \`releases admin discovery evaluate ${resolved.url} --json\` → read pageStructure (single-page | index | unknown).
2. single-page → return structure "single-page", pages=[${JSON.stringify(resolved.url)}] (it is entry-split during extraction).
3. index/unknown → enumerate per-release detail URLs. Prefer these sitemaps filtered to the changelog path: ${JSON.stringify(sitemaps)}. If none usable, fetch ${resolved.url} and parse the index HTML for per-release links. Order newest-first if discernible.
Return the structure and the FULL discovered list (do not cap — the workflow caps).`,
  { label: "map-pages", phase: "Map", model: "sonnet", schema: MAP_SCHEMA },
);
const structure = (mapped && mapped.structure) || "unknown";
const discovered = mapped && Array.isArray(mapped.pages) ? mapped.pages : [];
const { fresh, skippedKnown } = selectNewUrls(discovered, knownUrls);
const { targets, capped, deferred: cappedOut, logLine: capLog } = applyCap(fresh, MAX);
log(capLog);

if (DRY) {
  log(
    `dry-run: structure=${structure}, discovered=${discovered.length}, alreadyIngested=${skippedKnown}, wouldExtract=${capped}, cappedOut=${cappedOut}`,
  );
  return {
    status: "dry-run",
    source: SOURCE,
    url: resolved.url,
    structure,
    discovered: discovered.length,
    skippedKnown,
    capped,
    cappedOut,
    samplePages: targets.slice(0, 5),
    note: "Re-invoke with dryRun:false to extract + write. Set a turn budget (+Nk) to cap spend.",
  };
}
```

- [ ] **Step 5: Extract phase (budget-gated waves)**

Append:

```js
// ── Phase: Extract ───────────────────────────────────────────────────────────
phase("Extract");
const allRecords = [];
let done = 0,
  deferredForBudget = 0;
if (structure === "single-page") {
  const r = await agent(extractPrompt(targets[0] || resolved.url, true), {
    label: "extract:single",
    phase: "Extract",
    model: EXTRACT_MODEL,
    schema: RECORDS_SCHEMA,
  });
  if (r && Array.isArray(r.records)) allRecords.push(...r.records);
  done = 1;
} else {
  for (let i = 0; i < targets.length; i += WAVE) {
    const gate = budgetGate(
      budget.total,
      budget.remaining(),
      PER_WAVE_RESERVE,
      done,
      targets.length,
    );
    if (gate.stop) {
      log(gate.logLine);
      deferredForBudget = targets.length - done;
      break;
    }
    const wave = targets.slice(i, i + WAVE);
    const results = await parallel(
      wave.map(
        (u) => () =>
          agent(extractPrompt(u, false), {
            label: `extract:${short(u)}`,
            phase: "Extract",
            model: EXTRACT_MODEL,
            schema: RECORDS_SCHEMA,
          }),
      ),
    );
    for (const r of results) if (r && Array.isArray(r.records)) allRecords.push(...r.records);
    done += wave.length;
  }
}
```

- [ ] **Step 6: Write phase**

Append:

```js
// ── Phase: Write ─────────────────────────────────────────────────────────────
phase("Write");
const { kept, dropped, reasons } = dedupeRecords(allRecords);
let written = 0;
const writeErrors = [];
if (kept.length) {
  const writeRes = await agent(
    `POST these ${kept.length} already-deduped+cleaned release records to the Releases batch upsert for source "${resolved.slug}", in chunks of ${CHUNK_SIZE}.
For each chunk write a temp file and:
\`\`\`
curl -sS -X POST "$RELEASES_API_URL/v1/sources/${resolved.slug}/releases/batch" -H "Authorization: Bearer $RELEASES_API_KEY" -H "Content-Type: application/json" -d @chunk.json
\`\`\`
Body shape per chunk: { "releases": [ ...up to ${CHUNK_SIZE} records... ] }. Report how many were written and any non-2xx responses.
RECORDS_JSON (post these verbatim, do not alter): ${JSON.stringify(kept)}`,
    { label: "batch-write", phase: "Write", model: "haiku", schema: WRITE_SCHEMA },
  );
  written = (writeRes && writeRes.written) || 0;
  if (writeRes && Array.isArray(writeRes.errors)) writeErrors.push(...writeRes.errors);
}
```

- [ ] **Step 7: Report phase + return**

Append:

```js
// ── Phase: Report ────────────────────────────────────────────────────────────
phase("Report");
const validation = await agent(
  `Validate the backfill for source "${resolved.slug}": run \`releases tail ${resolved.slug} --json\` and report the total count, how many have empty content, and up to 5 sample titles.`,
  { label: "validate", phase: "Report", model: "haiku", schema: VALIDATE_SCHEMA },
);
const status = finalStatus(deferredForBudget);
const spentTokens = Math.round(budget.spent());
const summaryInputs = {
  source: SOURCE,
  slug: resolved.slug,
  url: resolved.url,
  structure,
  status,
  discovered: discovered.length,
  skippedKnown,
  capped,
  written,
  dropped,
  dropReasons: reasons,
  deferredForBudget,
  writeErrors,
  validation,
  spentTokens,
};
const rep = await agent(
  `Write the maintenance run summary for this backfill.
Target file: ${RUN_DIR ? RUN_DIR + "/summary.md" : "<run dir from `releases admin work status --json`>/summary.md"}
Follow docs/architecture/maintenance-workspace.md's summary.md template (status, per-target counts table, cost, what changed, findings). Use these numbers VERBATIM (do not invent): ${JSON.stringify(summaryInputs)}.
Cost line, exactly: "${spentTokens} output tokens this turn (budget.spent()); session sub-agent tokens, no managed-agent bill." Stamp the date via \`date -u +%FT%TZ\`. Surface data-quality findings (empty content, thin pages, deferred-for-budget pages, write errors).
${WE_STARTED_RUN ? "Then run `releases admin work end` (this run started it)." : "Do NOT run `releases admin work end` — a parent sweep owns this run."}
Return the absolute report path.`,
  {
    label: "run-report",
    phase: "Report",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { reportPath: { type: "string" } },
      required: ["reportPath"],
    },
  },
);

return {
  status,
  source: SOURCE,
  url: resolved.url,
  structure,
  discovered: discovered.length,
  skippedKnown,
  capped,
  extracted: done,
  written,
  dropped,
  deferredForBudget,
  actualCostTokens: spentTokens,
  reportPath: (rep && rep.reportPath) || null,
};
```

- [ ] **Step 8: Run the structural test (backfill-source half goes green)**

Run: `bun test tests/workflows/workflow-scripts.test.ts -t backfill-source`
Expected: the parse, meta, phase, and **inline-helper drift guard** assertions for `backfill-source.ts` PASS. (The `backfill-sweep.ts` cases still fail — that file lands in Task 4.)

If the drift guard fails, the inlined helper body differs from the module — re-copy it verbatim (minus `export `).

- [ ] **Step 9: Commit**

```bash
git add .claude/workflows/backfill-source.ts
git commit -m "feat(backfill): per-source backfill-source workflow engine"
```

---

## Task 4: `backfill-sweep.ts` — sequential multi-source wrapper

**Files:**

- Create: `.claude/workflows/backfill-sweep.ts`

- [ ] **Step 1: Write the script**

Create `.claude/workflows/backfill-sweep.ts`:

```js
export const meta = {
  name: "backfill-sweep",
  description:
    "Sequential multi-source local backfill: runs the backfill-source workflow over a list under one maintenance run, then writes a cross-run pass-rate/cost report.",
  whenToUse:
    "Backfill several sources locally in one pass without the managed-agent bill. Dry-run first (the default). Launch via the backfilling-sources skill.",
  phases: [
    { title: "Sweep", detail: "sequential backfill-source per target" },
    { title: "Report", detail: "cross-run pass-rate/cost table" },
  ],
};

let input = args;
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch {
    /* report below */
  }
}
input = input || {};
const SOURCES = Array.isArray(input.sources) ? input.sources : [];
const MAX = Number.isFinite(input.maxReleases) ? input.maxReleases : 50;
const DRY = input.dryRun !== false; // default true
const MODEL = input.model === "haiku" ? "haiku" : "sonnet";
if (!SOURCES.length) {
  log("backfill-sweep: missing required `sources` array");
  return { status: "error", error: "no sources" };
}

// ── Phase: Sweep ─────────────────────────────────────────────────────────────
phase("Sweep");
// Own one maintenance run so each nested per-source run reuses it (no .current-run collisions).
await agent(
  `Start a maintenance run for this sweep: \`releases admin work start backfill-sweep --json\` and \`mkdir -p ~/.releases/work/tasks ~/.releases/work/reports\`. Return { ok: true }.`,
  {
    label: "sweep-run-start",
    phase: "Sweep",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  },
);

const results = [];
for (const source of SOURCES) {
  log(`sweep: backfilling ${source}${DRY ? " (dry-run)" : ""}`);
  let r;
  try {
    r = await workflow("backfill-source", { source, maxReleases: MAX, dryRun: DRY, model: MODEL });
  } catch (e) {
    r = { status: "error", source, error: String((e && e.message) || e) };
  }
  results.push(r || { status: "error", source, error: "null result" });
}

// ── Phase: Report ────────────────────────────────────────────────────────────
phase("Report");
const ok = results.filter((r) => r && (r.status === "completed" || r.status === "dry-run")).length;
const rep = await agent(
  `Write a cross-run sweep report to ~/.releases/work/reports/<date>-backfill-sweep.md using docs/architecture/maintenance-workspace.md's report template (pass-rate + cost table + findings). Stamp <date> via \`date -u +%F\`.
Per-source results (use verbatim): ${JSON.stringify(results)}.
Then run \`releases admin work end\` to close the sweep's run. Return the absolute report path.`,
  {
    label: "sweep-report",
    phase: "Report",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { reportPath: { type: "string" } },
      required: ["reportPath"],
    },
  },
);
return {
  status: "completed",
  sources: SOURCES.length,
  succeeded: ok,
  reportPath: (rep && rep.reportPath) || null,
  results,
};
```

- [ ] **Step 2: Run the full structural test (all green)**

Run: `bun test tests/workflows/workflow-scripts.test.ts`
Expected: PASS — parse + meta + phase checks for both scripts, plus the drift guard.

- [ ] **Step 3: Commit**

```bash
git add .claude/workflows/backfill-sweep.ts
git commit -m "feat(backfill): sequential backfill-sweep wrapper"
```

---

## Task 5: `backfilling-sources` front-door skill

**Files:**

- Create: `src/agent/skills/backfilling-sources/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `src/agent/skills/backfilling-sources/SKILL.md`:

```markdown
---
name: backfilling-sources
description: Backfill a changelog source's full history locally in Claude Code via the backfill-source / backfill-sweep dynamic Workflows — preflight-gated, window-capped, budget-gated extraction written through the idempotent /batch upsert, with no managed-agent inference bill. Use when a source has a lot of history to pull in and dispatching the managed agent would be too expensive. Local Claude Code only.
---

# Backfilling Sources

Backfill a source's changelog history **without the managed-agent (MA) inference bill**, using the `backfill-source` dynamic Workflow (and `backfill-sweep` for several at once). The Workflow wraps the `local-ingest` primitives — preflight, fetch + extract, `/batch` upsert, parity rules — in a deterministic harness that owns the window cap, the budget gate, the dedup, and the safety gate, so the disciplines that are fragile when left to prose are enforced in code.

**Local Claude Code only.** The Workflow fans out `agent()` sub-agents and relies on a persistent local filesystem (`~/.releases/work/`) and the CLI's `RELEASES_API_*` env. It is not deployed to the MA fleet.

## When to use

- A source has substantial history to backfill and dispatching the MA per window is too expensive.
- A remote fetch burned an extraction loop and wrote 0 releases — extracting locally sidesteps the loop.

## When NOT to use

- A clean feed / GitHub source — just add it (`managing-sources`) and let cron fetch it.
- Inside an MA session — this is local-only.
- A publisher opt-out — the preflight gate refuses it (see below).

## Cost contract

- **Spends:** your Claude Code session tokens for the `agent()` sub-agents, hard-capped by the turn's `budget.total` (set with a `+Nk` directive). Extraction runs at Sonnet; the mechanical phases (preflight, run-setup, write, validate, report) run at Haiku.
- **Does NOT spend:** no MA coordinator-Sonnet, no Haiku worker loop, no metered Anthropic API bill. `POST /v1/workflows/update` is never called. `/batch` runs no AI on insert.
- Always **dry-run first** (the default) — it maps + estimates and writes nothing.

## Preflight gate (non-negotiable)

The Workflow runs `local-ingest`'s `preflight.ts` first and **fails closed**: `refuse` (an `ai-input=no` / `ai-train=no` opt-out) or a persistent `unknown` stops the run before any fetch or write. `conductor.build` (`Content-Signal: ai-train=no, ai-input=no`) is the regression target — it must be refused. Override only with explicit, documented publisher permission.

## Launch recipe

Dry-run one source, review the plan + counts, then commit:
```

Workflow({ name: "backfill-source", args: { source: "acme/changelog" } }) // dry-run (default)
Workflow({ name: "backfill-source", args: { source: "acme/changelog", dryRun: false, maxReleases: 50 } })

```

Set a turn budget to cap spend (e.g. prefix the request with `+300k`). Several sources at once:

```

Workflow({ name: "backfill-sweep", args: { sources: ["acme/changelog", "globex/releases"], dryRun: false } })

```

`args`: `source` (slug | src_ id | URL), `maxReleases` (default 50), `dryRun` (default true), `model` (`sonnet` default; `haiku` for bulk/simple). Sweep takes `sources: string[]`.

## After a run

The Workflow records the run under `~/.releases/work/` via `releases admin work start` (summary per source, cost line grounded in `budget.spent()`, cross-run sweep report). Review the report for data-quality findings (empty content, thin pages, deferred-for-budget pages).

## Related

- **`local-ingest`** — the primitives this wraps (preflight, `/batch`, parity); use it for one-off interactive ingests.
- **`parsing-changelogs`** — the extraction conventions (type, dates, rollups) the extract prompt follows.
- **`managing-sources`** — create the org/source first; naming, primary, playbooks.
- **`maintenance-workspace.md`** — the `~/.releases/work/` run-recording convention.
```

- [ ] **Step 2: Verify the frontmatter parses and matches the dir**

Run:

```bash
bun -e 'const t=await Bun.file("src/agent/skills/backfilling-sources/SKILL.md").text(); const m=t.match(/^---\n([\s\S]*?)\n---/); if(!m) throw new Error("no frontmatter"); if(!/name:\s*backfilling-sources/.test(m[1])) throw new Error("name mismatch"); if(!/description:\s*\S/.test(m[1])) throw new Error("no description"); console.log("ok: frontmatter valid, name matches dir");'
```

Expected: `ok: frontmatter valid, name matches dir`.

- [ ] **Step 3: Commit**

```bash
git add src/agent/skills/backfilling-sources/SKILL.md
git commit -m "feat(backfill): backfilling-sources front-door skill"
```

---

## Task 6: Docs cross-links

**Files:**

- Modify: `AGENTS.md` (Conventions section)
- Modify: `docs/architecture/local-ingest.md`

- [ ] **Step 1: Add the AGENTS.md conventions one-liner**

In `AGENTS.md`, immediately after the existing **Local ingest** convention bullet (the one starting "**Local ingest** (local Claude Code, no remote MA): the `local-ingest` skill…"), add:

```markdown
- **Local backfill workflow** (local Claude Code, no remote MA): the `backfill-source` / `backfill-sweep` dynamic Workflows (`.claude/workflows/`) wrap the `local-ingest` primitives in a deterministic harness — fail-closed preflight, explicit window cap, budget-gated extract waves, known-URL dedup, `/batch` upsert — to backfill a source's history locally without the MA extraction bill. Front-door: the `backfilling-sources` skill; dry-run is the default. See [local-ingest.md](docs/architecture/local-ingest.md).
```

- [ ] **Step 2: Add a cross-link in local-ingest.md**

At the end of `docs/architecture/local-ingest.md`, append a short section:

```markdown
## Backfill workflow

For full-history backfills, the `backfill-source` / `backfill-sweep` dynamic Workflows (`.claude/workflows/`) wrap these same primitives in a deterministic harness: the fail-closed preflight gate, the window cap with skip-logging, the budget gate between extract waves, the known-URL dedup, and the centralized `/batch` write all live in JS rather than prose. Launch them via the `backfilling-sources` skill (dry-run is the default). The decision logic is unit-tested in `tests/workflows/backfill-helpers.js` and inlined into the workflow (scripts can't import); `tests/workflows/workflow-scripts.test.ts` guards the copies against drift.
```

- [ ] **Step 3: Verify the full unit/structural suite still passes**

Run: `bun test tests/workflows/`
Expected: PASS (helper unit tests + structural tests).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/architecture/local-ingest.md
git commit -m "docs(backfill): cross-link the local backfill workflow"
```

---

## Task 7: Behavioral smoke (manual — spends tokens)

This is the only verification that exercises real agents, so it must be run by the operator, deliberately, with a turn budget. Do **not** automate it into CI.

**Files:** none (operator-run).

- [ ] **Step 1: Dry-run smoke (no writes)**

Pick a cooperative, already-onboarded source with a few un-ingested entries. Note its current `releases tail <slug> --json` count. Then:

```
Workflow({ name: "backfill-source", args: { source: "<slug>" } })
```

Expected return: `status:"dry-run"` with `structure`, `discovered`, `skippedKnown`, `capped`, `samplePages`. Re-check `releases tail <slug> --json` — count **unchanged** (zero writes).

- [ ] **Step 2: Conductor refusal regression**

```
Workflow({ name: "backfill-source", args: { source: "https://conductor.build/changelog" } })
```

Expected return: `status:"refused"`. No fetch of detail pages, no `/batch` write. This is the gate's reason for existing.

- [ ] **Step 3: Small live run**

With a turn budget (prefix the request with e.g. `+200k`):

```
Workflow({ name: "backfill-source", args: { source: "<slug>", dryRun: false, maxReleases: 5 } })
```

Expected: `status:"completed"`, `written` ≥ 1. Verify via `releases tail <slug> --json` — new rows with non-empty titles/dates/content. Confirm a `summary.md` exists in the run dir (`releases admin work status --json` → run dir) with a `budget.spent()`-grounded cost line.

- [ ] **Step 4: Record the smoke results**

Note the three outcomes (dry-run counts, refusal, live-run written count + report path) in the PR description. If any diverged, fix the script and re-run before merging.

---

## Self-review notes (author)

- **Spec coverage:** preflight fail-closed gate (Task 3 Step 3 + Task 1 `preflightDecision`); window cap + skip-log (Task 1 `applyCap`, Task 3 Step 4); budget gate (Task 1 `budgetGate`, Task 3 Step 5); known-URL dedup (Task 1 `selectNewUrls`, Task 3 Step 4); record dedup + version clean (Task 1 `dedupeRecords`/`cleanVersion`); model tiering (Task 3 agent `model` opts); dry-run default (Task 3 Step 2/4); `/batch` chunked write (Task 1 `chunk`, Task 3 Step 6); run-recording via `work start` + `budget.spent()` cost line (Task 3 Step 3/7); sweep sequential + single run (Task 4); skill front-door (Task 5); parity rules (extract prompt, Task 3 Step 2); Conductor regression (Task 7 Step 2). All spec sections map to a task.
- **Deferred per spec:** extract-lib `engine` toggle, sweep concurrency, single-page entry-splitting cost — not implemented; called out in the spec's "Open questions / deferred".
- **One refinement to confirm at handoff:** the spec said extract agents never write and the parent writes — implemented as the parent collecting schema-validated records and a single Haiku write agent POSTing them inline. For very large caps this re-sends bodies through the write prompt; a file-handoff variant (extract agents drop per-page JSON into the run dir, write agent globs them) avoids that and is the natural next optimization if cap sizes grow. Kept the spec's simpler shape for v1.

```

```
