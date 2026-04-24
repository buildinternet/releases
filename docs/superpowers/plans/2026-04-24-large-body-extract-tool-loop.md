# Large-Body Extract: Tool-Use Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-turn tool-use loop in `extract-from-body.ts` that triggers for bodies above 50K tokens, letting the model navigate the body via `get_slice` / `query_json` tools instead of inlining the whole thing. Hard fallback to the existing one-shot path preserves current behavior as the worst case.

**Architecture:** Two-tier branch inside `extract-from-body.ts`. Small bodies use the unchanged one-shot `/v1/messages` call. Large bodies hand off to a new `extract-with-tools.ts` that runs a multi-round stream loop with explicit `cache_control` markers. Preview builder computes a deterministic JSON schema sketch (strict or partial parse) or HTML first+last slice as the initial user message. Any error in the loop triggers one-shot fallback.

**Tech Stack:** TypeScript, `@anthropic-ai/sdk`, `partial-json`, `jsonpath-plus`, Drizzle (D1), Bun test.

**Spec:** `docs/superpowers/specs/2026-04-24-large-body-extract-tool-loop-design.md`

**Branch:** `feat/extract-tool-loop` (already created with spec committed).

---

## File Structure

New files:

- `packages/adapters/src/extract/preview-builder.ts` — pure helpers for JSON schema sketch (strict + partial) and HTML preview.
- `packages/adapters/src/extract/preview-builder.test.ts` — unit tests.
- `packages/adapters/src/extract/tool-handlers.ts` — `get_slice` and `query_json` handlers.
- `packages/adapters/src/extract/tool-handlers.test.ts` — unit tests.
- `packages/adapters/src/extract/extract-with-tools.ts` — loop controller.
- `packages/adapters/src/extract/extract-with-tools.test.ts` — integration tests with Anthropic response fixtures.

Modified files:

- `packages/core/src/schema.ts:228` — six new columns on `usage_log`.
- `packages/adapters/package.json` — add `partial-json`, `jsonpath-plus`.
- `packages/adapters/src/extract/extract-from-body.ts` — tier gate + fallback wiring.
- `packages/adapters/src/extract/shared.ts` — new constants (`MAX_BODY_CHARS_TOOLLOOP`, tool schema definitions, tool-loop system prompt).
- `packages/adapters/src/extract/types.ts` — extend `ExtractFromBodyResult` / `ExtractDeps` with new telemetry fields if needed.
- `packages/adapters/src/extract/run-direct-fetch.ts:117` — pass new telemetry fields to `logUsage`.
- `packages/adapters/src/extract/run-agent.ts` — same as above.

Migrations:

- New file under `workers/api/drizzle/` (generated via `bun run db:generate`).

---

## Task 1: Add dependencies

**Files:**

- Modify: `packages/adapters/package.json`

- [ ] **Step 1: Install partial-json and jsonpath-plus**

Run:

```bash
cd "$(git rev-parse --show-toplevel)/packages/adapters"
bun add partial-json jsonpath-plus
```

- [ ] **Step 2: Verify they appear in package.json under dependencies**

Run: `grep -E "partial-json|jsonpath-plus" packages/adapters/package.json` (from repo root)
Expected: both appear in the `dependencies` block with concrete versions.

- [ ] **Step 3: Verify type imports resolve**

Run (from repo root): `npx tsc --noEmit -p packages/adapters/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/adapters/package.json ../../bun.lock
git commit -m "feat(extract): add partial-json and jsonpath-plus deps"
```

---

## Task 2: Schema migration — add six columns to usage_log

**Files:**

- Modify: `packages/core/src/schema.ts:228`
- Create: migration file under `workers/api/drizzle/` (generated)

- [ ] **Step 1: Add columns to the `usageLog` table**

In `packages/core/src/schema.ts`, replace the `usageLog` definition:

```ts
export const USAGE_EXTRACTION_MODES = [
  "oneshot",
  "toolloop",
  "toolloop:partial",
  "toolloop:no_sketch",
  "fallback_to_oneshot",
] as const;
export type UsageExtractionMode = (typeof USAGE_EXTRACTION_MODES)[number];

export const USAGE_FALLBACK_REASONS = [
  "max_rounds",
  "tool_error",
  "no_terminal_call",
  "max_tokens",
  "sdk_error",
] as const;
export type UsageFallbackReason = (typeof USAGE_FALLBACK_REASONS)[number];

export const usageLog = sqliteTable("usage_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  operation: text("operation").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  sourceSlug: text("source_slug"),
  releaseCount: integer("release_count"),
  extractionMode: text("extraction_mode").$type<UsageExtractionMode>(),
  toolRounds: integer("tool_rounds"),
  toolChars: integer("tool_chars"),
  fallbackReason: text("fallback_reason").$type<UsageFallbackReason>(),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
```

- [ ] **Step 2: Generate the Drizzle migration**

Run (from repo root): `bun run db:generate`
Expected: a new file under `workers/api/drizzle/` with six `ALTER TABLE usage_log ADD COLUMN ...` statements.

- [ ] **Step 3: Apply locally and verify**

Run: `bun run db:migrate:local`
Expected: migration applies cleanly, no errors.

Verify the columns exist:

```bash
sqlite3 "$(find "$(git rev-parse --show-toplevel)/workers/api/.wrangler" -name '*.sqlite' | head -1)" ".schema usage_log"
```

Expected: all six new columns present.

- [ ] **Step 4: Type-check**

Run (from repo root): `npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: no errors. The `NewUsageLog` inferred type should now include all six new optional fields.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schema.ts workers/api/drizzle/
git commit -m "feat(schema): add extraction-mode + cache-token columns to usage_log"
```

---

## Task 3: Preview builder — JSON schema sketch (strict parse)

**Files:**

- Create: `packages/adapters/src/extract/preview-builder.ts`
- Create: `packages/adapters/src/extract/preview-builder.test.ts`

- [ ] **Step 1: Write failing tests for `buildJsonSketch` (strict parse)**

Create `preview-builder.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildJsonSketch } from "./preview-builder.js";

describe("buildJsonSketch — strict parse", () => {
  test("returns top-level keys with types", () => {
    const body = JSON.stringify({ foo: "bar", count: 3, flag: true, items: [] });
    const result = buildJsonSketch(body);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("strict");
    expect(result.sketch).toContain("foo: string");
    expect(result.sketch).toContain("count: number");
    expect(result.sketch).toContain("flag: boolean");
    expect(result.sketch).toContain("items: array(len=0)");
  });

  test("walks to depth 2 for nested objects", () => {
    const body = JSON.stringify({
      result: { data: { nodes: [{ id: 1 }, { id: 2 }, { id: 3 }] } },
    });
    const result = buildJsonSketch(body);
    expect(result.sketch).toContain("result:");
    expect(result.sketch).toContain("data:");
    // Depth-2: nodes is seen but not its interior
    expect(result.sketch).toContain("nodes: array(len=3)");
    expect(result.sketch).not.toContain("id: number");
  });

  test("reports array lengths for top-level arrays", () => {
    const body = JSON.stringify(new Array(42).fill({ a: 1 }));
    const result = buildJsonSketch(body);
    expect(result.ok).toBe(true);
    expect(result.sketch).toContain("[root]: array(len=42)");
  });
});
```

- [ ] **Step 2: Run the tests — expect failure**

Run from the repo root: `bun test packages/adapters/src/extract/preview-builder.test.ts`
Expected: FAIL — `buildJsonSketch is not a function` / module not found.

- [ ] **Step 3: Implement `buildJsonSketch` with strict-parse logic**

Create `preview-builder.ts`:

```ts
export type SketchResult =
  | { ok: true; mode: "strict" | "partial"; sketch: string; truncatedAt?: number }
  | { ok: false; mode: "none" };

const MAX_DEPTH = 2;

function describeType(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "object";
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${describeType(v, depth + 1)}`)
      .join(", ");
    return `{ ${entries} }`;
  }
  return typeof value;
}

function formatSketch(root: unknown): string {
  if (Array.isArray(root)) return `[root]: array(len=${root.length})`;
  if (root && typeof root === "object") {
    return Object.entries(root as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${describeType(v, 1)}`)
      .join("\n");
  }
  return `[root]: ${describeType(root, 0)}`;
}

export function buildJsonSketch(body: string): SketchResult {
  try {
    const parsed = JSON.parse(body);
    return { ok: true, mode: "strict", sketch: formatSketch(parsed) };
  } catch {
    return { ok: false, mode: "none" };
  }
}
```

- [ ] **Step 4: Run the tests — expect pass**

Run: `bun test packages/adapters/src/extract/preview-builder.test.ts`
Expected: PASS for all three tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/extract/preview-builder.ts packages/adapters/src/extract/preview-builder.test.ts
git commit -m "feat(extract): JSON schema sketch builder with strict parse"
```

---

## Task 4: Preview builder — partial-JSON recovery

**Files:**

- Modify: `packages/adapters/src/extract/preview-builder.ts`
- Modify: `packages/adapters/src/extract/preview-builder.test.ts`

- [ ] **Step 1: Add failing tests for partial-parse fallback**

Append to `preview-builder.test.ts`:

```ts
describe("buildJsonSketch — partial parse", () => {
  test("recovers schema from a truncated JSON prefix", () => {
    const full = JSON.stringify({
      componentChunkName: "xyz",
      result: { data: { nodes: [{ id: 1 }, { id: 2 }, { id: 3 }] } },
    });
    const truncated = full.slice(0, Math.floor(full.length * 0.6));
    const result = buildJsonSketch(truncated);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("partial");
    expect(result.sketch).toContain("componentChunkName");
    expect(result.sketch).toContain("result:");
    expect(typeof result.truncatedAt).toBe("number");
  });

  test("returns ok=false when body is not JSON at all", () => {
    const result = buildJsonSketch("<html><body>hi</body></html>");
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("none");
  });
});
```

- [ ] **Step 2: Run the tests — expect failure on the partial case**

Run: `bun test packages/adapters/src/extract/preview-builder.test.ts`
Expected: The "recovers schema from a truncated JSON prefix" test FAILS (current code returns `ok: false`); the HTML test passes.

- [ ] **Step 3: Integrate `partial-json` fallback**

Modify `preview-builder.ts`:

```ts
import { parse as partialParse } from "partial-json";

// ... keep existing describeType / formatSketch ...

export function buildJsonSketch(body: string): SketchResult {
  try {
    const parsed = JSON.parse(body);
    return { ok: true, mode: "strict", sketch: formatSketch(parsed) };
  } catch {
    // Strict parse failed — try partial recovery.
  }

  try {
    const parsed = partialParse(body);
    // partial-json returns undefined/null when nothing could be recovered
    if (parsed === undefined || parsed === null) {
      return { ok: false, mode: "none" };
    }
    // Estimate truncation point: last char the parser accepted. partial-json
    // doesn't expose this directly, so we approximate it by finding the last
    // balanced structural char. Good enough for a preview note.
    const truncatedAt = estimateTruncation(body);
    return { ok: true, mode: "partial", sketch: formatSketch(parsed), truncatedAt };
  } catch {
    return { ok: false, mode: "none" };
  }
}

function estimateTruncation(body: string): number {
  // Walk backward from the end looking for the last char that is ",", "]", "}", or a digit/alpha.
  // This is a heuristic — it just gives the model a rough byte offset to orient around.
  for (let i = body.length - 1; i >= 0; i--) {
    const c = body[i]!;
    if (c === "," || c === "]" || c === "}" || /[0-9a-zA-Z"]/.test(c)) return i;
  }
  return body.length;
}
```

- [ ] **Step 4: Run the tests — expect all pass**

Run: `bun test packages/adapters/src/extract/preview-builder.test.ts`
Expected: PASS for all five tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/extract/preview-builder.ts packages/adapters/src/extract/preview-builder.test.ts
git commit -m "feat(extract): partial-JSON recovery for preview sketch"
```

---

## Task 5: Preview builder — HTML strip + truncate

**Files:**

- Modify: `packages/adapters/src/extract/preview-builder.ts`
- Modify: `packages/adapters/src/extract/preview-builder.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `preview-builder.test.ts`:

```ts
describe("buildHtmlPreview", () => {
  test("strips script, style, svg, nav, header, footer tags", () => {
    const html = `
      <html>
        <head><script>evil()</script><style>.x{}</style></head>
        <body>
          <nav>Home</nav>
          <header>Header</header>
          <svg><path/></svg>
          <main>Real content here</main>
          <footer>Footer</footer>
        </body>
      </html>
    `;
    const result = buildHtmlPreview(html);
    expect(result).not.toContain("evil()");
    expect(result).not.toContain(".x{}");
    expect(result).not.toContain("Home");
    expect(result).not.toContain("<path");
    expect(result).toContain("Real content here");
  });

  test("caps output at first 2K + last 2K chars", () => {
    const html = `<main>${"a".repeat(10_000)}</main>`;
    const result = buildHtmlPreview(html);
    expect(result.length).toBeLessThanOrEqual(4200); // 2K + 2K + separator
  });

  test("returns full content when under cap", () => {
    const html = "<main>short</main>";
    const result = buildHtmlPreview(html);
    expect(result).toContain("short");
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `bun test packages/adapters/src/extract/preview-builder.test.ts`
Expected: FAIL — `buildHtmlPreview is not a function`.

- [ ] **Step 3: Implement `buildHtmlPreview`**

Append to `preview-builder.ts`:

```ts
const STRIP_TAGS = ["script", "style", "svg", "nav", "header", "footer"];
const PREVIEW_HEAD = 2000;
const PREVIEW_TAIL = 2000;

export function buildHtmlPreview(body: string): string {
  let cleaned = body;
  for (const tag of STRIP_TAGS) {
    // Remove full tag blocks (including content) — non-greedy, case-insensitive.
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
    // Also remove self-closing variants.
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*\\/>`, "gi"), "");
  }

  if (cleaned.length <= PREVIEW_HEAD + PREVIEW_TAIL) return cleaned;

  const head = cleaned.slice(0, PREVIEW_HEAD);
  const tail = cleaned.slice(-PREVIEW_TAIL);
  return `${head}\n\n[... ${cleaned.length - PREVIEW_HEAD - PREVIEW_TAIL} chars elided ...]\n\n${tail}`;
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test packages/adapters/src/extract/preview-builder.test.ts`
Expected: PASS for all previous tests plus three new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/extract/preview-builder.ts packages/adapters/src/extract/preview-builder.test.ts
git commit -m "feat(extract): HTML preview builder with tag stripping + cap"
```

---

## Task 6: Preview orchestrator — `buildPreview`

**Files:**

- Modify: `packages/adapters/src/extract/preview-builder.ts`
- Modify: `packages/adapters/src/extract/preview-builder.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `preview-builder.test.ts`:

```ts
describe("buildPreview", () => {
  test("routes to JSON path when body parses as JSON", () => {
    const body = JSON.stringify({ foo: "bar" });
    const result = buildPreview({
      body,
      sourceUrl: "https://x.test",
      fetchUrl: "https://x.test/feed.json",
    });
    expect(result.contentType).toBe("json");
    expect(result.sketch).toContain("foo: string");
    expect(result.queryJsonAvailable).toBe(true);
  });

  test("routes to HTML path when body is not JSON", () => {
    const body = "<html><body><main>hello</main></body></html>";
    const result = buildPreview({ body, sourceUrl: "https://x.test", fetchUrl: "https://x.test/" });
    expect(result.contentType).toBe("html");
    expect(result.sketch).toContain("hello");
    expect(result.queryJsonAvailable).toBe(false);
  });

  test("reports partial mode when JSON is truncated", () => {
    const body = '{"a":1,"b":[1,2,3';
    const result = buildPreview({
      body,
      sourceUrl: "https://x.test",
      fetchUrl: "https://x.test/feed.json",
    });
    expect(result.contentType).toBe("json");
    expect(result.mode).toBe("toolloop:partial");
  });

  test("reports no_sketch mode when nothing can be parsed", () => {
    // A totally malformed, not-HTML body
    const body = "<<<<>>>>";
    const result = buildPreview({ body, sourceUrl: "https://x.test", fetchUrl: "https://x.test/" });
    // HTML path always succeeds (just trivial cleaning); but the JSON-path result would be no_sketch
    // We care about the mode being correctly reported for downstream logging.
    expect(["toolloop", "toolloop:no_sketch"]).toContain(result.mode);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `bun test packages/adapters/src/extract/preview-builder.test.ts`
Expected: FAIL — `buildPreview is not a function`.

- [ ] **Step 3: Implement `buildPreview`**

Append to `preview-builder.ts`:

```ts
import type { UsageExtractionMode } from "@buildinternet/releases-core/schema";

export interface BuildPreviewOpts {
  body: string;
  sourceUrl: string;
  fetchUrl: string;
  approxTokens?: number;
}

export interface PreviewResult {
  message: string;
  contentType: "json" | "html";
  mode: UsageExtractionMode;
  queryJsonAvailable: boolean;
  sketch: string;
}

export function buildPreview(opts: BuildPreviewOpts): PreviewResult {
  const { body, sourceUrl, fetchUrl, approxTokens } = opts;
  const header =
    `Canonical source URL: ${sourceUrl}\n` +
    `Fetched from: ${fetchUrl}\n` +
    `Body length: ${body.length.toLocaleString()} chars` +
    (approxTokens ? ` (~${approxTokens.toLocaleString()} tokens)` : "");

  const json = buildJsonSketch(body);

  if (json.ok) {
    const mode: UsageExtractionMode = json.mode === "partial" ? "toolloop:partial" : "toolloop";
    const truncNote =
      json.mode === "partial" && json.truncatedAt !== undefined
        ? `\n\nNote: body parse was truncated at ~byte ${json.truncatedAt.toLocaleString()}. ` +
          `Structure past this point may be missing. If query_json returns empty for a deep path, fall back to get_slice.`
        : "";

    const message =
      `${header}\n` +
      `Content type: JSON\n\n` +
      `Schema sketch (depth 2):\n${json.sketch}${truncNote}\n\n` +
      toolInstructions(true);

    return { message, contentType: "json", mode, queryJsonAvailable: true, sketch: json.sketch };
  }

  // Fall back to HTML preview.
  const html = buildHtmlPreview(body);
  const message =
    `${header}\n` +
    `Content type: HTML\n\n` +
    `Preview (first/last 2K chars, chrome stripped):\n${html}\n\n` +
    toolInstructions(false);

  // If the body was so unusable that the HTML preview is essentially the same string we got back,
  // flag it as no_sketch. Good-enough heuristic: unchanged length and no recognizable tag.
  const looksUnusable = html.length === body.length && !/<[a-z]/i.test(body);
  const mode: UsageExtractionMode = looksUnusable ? "toolloop:no_sketch" : "toolloop";

  return { message, contentType: "html", mode, queryJsonAvailable: false, sketch: html };
}

function toolInstructions(queryJsonAvailable: boolean): string {
  const tools = queryJsonAvailable
    ? "`query_json(path)` to target a JSONPath (e.g. `$.result.data.allRoadmap.nodes[*]`), or `get_slice(start, length)` for raw byte ranges."
    : "`get_slice(start, length)` to pull raw byte ranges from the body.";
  return (
    `The body is available via tools — not inlined below. Use ${tools} ` +
    `Call \`extract_releases\` with the entries you found when done.`
  );
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test packages/adapters/src/extract/preview-builder.test.ts`
Expected: PASS for all tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/extract/preview-builder.ts packages/adapters/src/extract/preview-builder.test.ts
git commit -m "feat(extract): preview orchestrator routes JSON vs HTML"
```

---

## Task 7: Tool handler — `get_slice`

**Files:**

- Create: `packages/adapters/src/extract/tool-handlers.ts`
- Create: `packages/adapters/src/extract/tool-handlers.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tool-handlers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { handleGetSlice, MAX_TOOL_RESULT_CHARS } from "./tool-handlers.js";

describe("handleGetSlice", () => {
  test("returns the exact slice for in-bounds args", () => {
    const body = "abcdefghij";
    expect(handleGetSlice(body, { start: 2, length: 4 })).toBe("cdef");
  });

  test("clamps negative start to 0", () => {
    expect(handleGetSlice("abcdef", { start: -5, length: 3 })).toBe("abc");
  });

  test("clamps length that overruns the body", () => {
    expect(handleGetSlice("abcdef", { start: 4, length: 1000 })).toBe("ef");
  });

  test("caps output at MAX_TOOL_RESULT_CHARS", () => {
    const body = "x".repeat(50_000);
    const out = handleGetSlice(body, { start: 0, length: 50_000 });
    expect(out.length).toBe(MAX_TOOL_RESULT_CHARS);
  });

  test("returns empty string when start is past end", () => {
    expect(handleGetSlice("abc", { start: 100, length: 10 })).toBe("");
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `bun test packages/adapters/src/extract/tool-handlers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `handleGetSlice`**

Create `tool-handlers.ts`:

```ts
export const MAX_TOOL_RESULT_CHARS = 20_000;

export interface GetSliceInput {
  start: number;
  length: number;
}

export function handleGetSlice(body: string, input: GetSliceInput): string {
  const start = Math.max(0, Math.min(Math.floor(input.start), body.length));
  const length = Math.max(0, Math.min(Math.floor(input.length), MAX_TOOL_RESULT_CHARS));
  return body.slice(start, start + length);
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test packages/adapters/src/extract/tool-handlers.test.ts`
Expected: PASS for all five tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/extract/tool-handlers.ts packages/adapters/src/extract/tool-handlers.test.ts
git commit -m "feat(extract): get_slice tool handler"
```

---

## Task 8: Tool handler — `query_json`

**Files:**

- Modify: `packages/adapters/src/extract/tool-handlers.ts`
- Modify: `packages/adapters/src/extract/tool-handlers.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tool-handlers.test.ts`:

```ts
describe("handleQueryJson", () => {
  const body = JSON.stringify({
    result: {
      data: {
        nodes: [
          { id: 1, title: "a" },
          { id: 2, title: "b" },
          { id: 3, title: "c" },
        ],
      },
    },
  });

  test("returns matched subtree for a valid JSONPath", () => {
    const out = handleQueryJson(body, { path: "$.result.data.nodes[0]" });
    expect(JSON.parse(out)).toEqual({ id: 1, title: "a" });
  });

  test("returns array for wildcard paths", () => {
    const out = handleQueryJson(body, { path: "$.result.data.nodes[*]" });
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
  });

  test("returns empty-match marker for a miss", () => {
    const out = handleQueryJson(body, { path: "$.nonexistent.path" });
    expect(out).toMatch(/no matches/i);
  });

  test("truncates oversized match sets and reports remainder", () => {
    // Build a body where the match set is very large
    const large = JSON.stringify({ arr: new Array(5000).fill({ x: "y".repeat(20) }) });
    const out = handleQueryJson(large, { path: "$.arr[*]" });
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 200); // +slack for suffix marker
    expect(out).toMatch(/\.\.\. \d+ more items elided/);
  });

  test("throws or returns error marker for malformed path", () => {
    // handler should not crash the loop — it either returns a structured error marker
    // or throws; consuming code expects throws to trigger fallback.
    expect(() => handleQueryJson(body, { path: "??invalid??" })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `bun test packages/adapters/src/extract/tool-handlers.test.ts`
Expected: FAIL — `handleQueryJson is not exported`.

- [ ] **Step 3: Implement `handleQueryJson`**

Append to `tool-handlers.ts`:

```ts
import { JSONPath } from "jsonpath-plus";

export interface QueryJsonInput {
  path: string;
}

export function handleQueryJson(body: string, input: QueryJsonInput): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // partial-json is intentionally not used here — the body was already found to be
    // parseable-or-partial in the preview. If the full body isn't valid JSON at query
    // time, the caller shouldn't have offered query_json.
    throw new Error("body is not valid JSON");
  }

  const result = JSONPath({ path: input.path, json: parsed as object });

  if (result.length === 0) {
    return `no matches for ${input.path}`;
  }

  // Serialize incrementally — stop when we hit the cap.
  const serialized: string[] = [];
  let totalLen = 0;
  let included = 0;

  for (const item of result) {
    const next = JSON.stringify(item);
    if (totalLen + next.length > MAX_TOOL_RESULT_CHARS) break;
    serialized.push(next);
    totalLen += next.length + 1; // +1 for separator
    included++;
  }

  if (included === result.length) {
    return result.length === 1 ? serialized[0]! : `[${serialized.join(",")}]`;
  }

  const elided = result.length - included;
  return `[${serialized.join(",")}] ... ${elided} more items elided (total ${result.length})`;
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test packages/adapters/src/extract/tool-handlers.test.ts`
Expected: PASS for all tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/extract/tool-handlers.ts packages/adapters/src/extract/tool-handlers.test.ts
git commit -m "feat(extract): query_json tool handler with JSONPath"
```

---

## Task 9: Loop controller scaffolding — happy path (single round)

**Files:**

- Modify: `packages/adapters/src/extract/shared.ts`
- Create: `packages/adapters/src/extract/extract-with-tools.ts`
- Create: `packages/adapters/src/extract/extract-with-tools.test.ts`

- [ ] **Step 1: Add new constants + tool schemas to `shared.ts`**

In `shared.ts`, add:

```ts
export const MAX_BODY_CHARS_TOOLLOOP = 2_000_000;
export const MAX_ROUNDS = 8;
export const MAX_TOTAL_TOOL_CHARS = 80_000;

export const TOOLLOOP_SYSTEM_PROMPT = `You are a changelog parser operating in tool-use mode. The body of a URL is NOT included in this conversation — it is available through tools.

Use \`query_json\` for JSONPath queries into structured content, or \`get_slice\` for byte-range reads (both JSON and HTML). Both return at most 20K chars per call; if a match set is larger, a remainder marker is included.

When you have enough information, call \`extract_releases\` with all the entries you found. That ends the extraction.`;

import type Anthropic from "@anthropic-ai/sdk";

export const getSliceTool: Anthropic.Tool = {
  name: "get_slice",
  description: "Return a substring of the body. Clamps out-of-bounds args; capped at 20K chars.",
  input_schema: {
    type: "object",
    properties: {
      start: { type: "integer", description: "Starting char offset (0-indexed)." },
      length: { type: "integer", description: "Number of chars to return." },
    },
    required: ["start", "length"],
  },
};

export const queryJsonTool: Anthropic.Tool = {
  name: "query_json",
  description:
    "Run a JSONPath expression against the body. Returns matched subtree as JSON text, capped at 20K chars.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "JSONPath expression, e.g. $.result.data.nodes[*]",
      },
    },
    required: ["path"],
  },
};
```

- [ ] **Step 2: Write failing test for the happy path (terminal tool in round 1)**

Create `extract-with-tools.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { extractWithTools } from "./extract-with-tools.js";
import { mockAnthropicClient } from "./test-helpers/anthropic-mock.js";
import type { ExtractDeps } from "./types.js";
import { createLogger } from "@releases/lib/logger";

function makeDeps(client: unknown): ExtractDeps {
  return {
    anthropicClient: client as never,
    agentModel: "claude-sonnet-4-6",
    logger: createLogger("test"),
    repo: {} as never,
  };
}

describe("extractWithTools — happy path", () => {
  test("returns entries when model emits extract_releases in round 1", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "extract_releases",
            input: {
              releases: [
                {
                  title: "v1.0",
                  publishedAt: "2026-04-01",
                  url: "https://x.test/r/1",
                  body: "initial",
                },
              ],
            },
          },
        ],
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 500,
        },
      },
    ]);

    const result = await extractWithTools(
      {
        body: JSON.stringify({ nodes: [{ title: "v1.0" }] }),
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(client),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("v1.0");
    expect(result.mode).toBe("toolloop");
    expect(result.toolRounds).toBe(0);
    expect(result.totalInput).toBe(1000);
    expect(result.cacheWriteTokens).toBe(500);
  });
});
```

- [ ] **Step 3: Create a minimal Anthropic mock helper**

Create `packages/adapters/src/extract/test-helpers/anthropic-mock.ts`:

```ts
import type Anthropic from "@anthropic-ai/sdk";

interface MockedResponse {
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  content: Anthropic.ContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Produces a stand-in for an Anthropic.Client whose messages.stream() returns
 * the provided responses in order. One call per round. Throws if the test asks
 * for more rounds than were pre-seeded.
 */
export function mockAnthropicClient(responses: MockedResponse[]): Pick<Anthropic, "messages"> {
  let i = 0;
  return {
    messages: {
      stream: (() => {
        if (i >= responses.length) {
          throw new Error(`mockAnthropicClient ran out of responses after ${i} calls`);
        }
        const resp = responses[i++]!;
        const finalMessage = Promise.resolve({
          id: `msg_${i}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: resp.content,
          stop_reason: resp.stop_reason,
          stop_sequence: null,
          usage: {
            input_tokens: resp.usage.input_tokens,
            output_tokens: resp.usage.output_tokens,
            cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: resp.usage.cache_creation_input_tokens ?? 0,
          },
        } as Anthropic.Message);
        return { finalMessage: () => finalMessage } as never;
      }) as never,
    } as never,
  };
}
```

- [ ] **Step 4: Run test — expect failure**

Run: `bun test packages/adapters/src/extract/extract-with-tools.test.ts`
Expected: FAIL — `extractWithTools is not a function`.

- [ ] **Step 5: Implement happy-path `extractWithTools`**

Create `extract-with-tools.ts`:

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { UsageExtractionMode, UsageFallbackReason } from "@buildinternet/releases-core/schema";
import { buildPreview } from "./preview-builder.js";
import { handleGetSlice, handleQueryJson } from "./tool-handlers.js";
import {
  extractReleasesToolFull,
  getSliceTool,
  queryJsonTool,
  TOOLLOOP_SYSTEM_PROMPT,
  MAX_ROUNDS,
  MAX_TOTAL_TOOL_CHARS,
} from "./shared.js";
import type { ExtractDeps, ExtractedEntry } from "./types.js";

export interface ExtractWithToolsOpts {
  body: string;
  systemPrompt: string;
  userMessage: string;
  sourceUrl: string;
  fetchUrl: string;
  approxTokens?: number;
}

export interface ExtractWithToolsResult {
  entries: ExtractedEntry[];
  totalInput: number;
  totalOutput: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolRounds: number;
  toolChars: number;
  mode: UsageExtractionMode;
  hitMaxTokens: boolean;
  fallbackReason?: UsageFallbackReason;
}

export async function extractWithTools(
  opts: ExtractWithToolsOpts,
  deps: ExtractDeps,
): Promise<ExtractWithToolsResult> {
  const preview = buildPreview({
    body: opts.body,
    sourceUrl: opts.sourceUrl,
    fetchUrl: opts.fetchUrl,
    approxTokens: opts.approxTokens,
  });

  const tools: Anthropic.Tool[] = [extractReleasesToolFull, getSliceTool];
  if (preview.queryJsonAvailable) tools.push(queryJsonTool);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `${opts.userMessage}\n\n${preview.message}` },
  ];

  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: `${opts.systemPrompt}\n\n${TOOLLOOP_SYSTEM_PROMPT}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  let totalInput = 0;
  let totalOutput = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  const stream = deps.anthropicClient.messages.stream({
    model: deps.agentModel,
    max_tokens: 16_384,
    system: systemBlocks,
    tools,
    messages,
  });
  const response = await stream.finalMessage();

  totalInput += response.usage.input_tokens;
  totalOutput += response.usage.output_tokens;
  cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
  cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

  const terminal = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "extract_releases",
  );
  if (terminal) {
    const input = terminal.input as { releases: ExtractedEntry[] };
    return {
      entries: input.releases ?? [],
      totalInput,
      totalOutput,
      cacheReadTokens,
      cacheWriteTokens,
      toolRounds: 0,
      toolChars: 0,
      mode: preview.mode,
      hitMaxTokens: response.stop_reason === "max_tokens",
    };
  }

  // Task 10 will add multi-round handling. For now, throw so the caller can catch and fall back.
  throw new Error("extract-with-tools: expected extract_releases in round 1 (task 9 scaffold)");
}
```

- [ ] **Step 6: Run test — expect pass**

Run: `bun test packages/adapters/src/extract/extract-with-tools.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/extract/shared.ts \
        packages/adapters/src/extract/extract-with-tools.ts \
        packages/adapters/src/extract/extract-with-tools.test.ts \
        packages/adapters/src/extract/test-helpers/anthropic-mock.ts
git commit -m "feat(extract): tool-loop scaffold + happy-path single round"
```

---

## Task 10: Multi-round handling — tool_use → tool_result → re-stream

**Files:**

- Modify: `packages/adapters/src/extract/extract-with-tools.ts`
- Modify: `packages/adapters/src/extract/extract-with-tools.test.ts`

- [ ] **Step 1: Write failing test covering a multi-round case**

Append to `extract-with-tools.test.ts`:

```ts
describe("extractWithTools — multi-round", () => {
  test("handles a query_json round followed by extract_releases", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "query_json",
            input: { path: "$.nodes[*]" },
          },
        ],
        usage: { input_tokens: 1200, output_tokens: 100 },
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "extract_releases",
            input: {
              releases: [
                { title: "v1", publishedAt: "2026-04-01", url: "https://x.test/1", body: "a" },
                { title: "v2", publishedAt: "2026-04-02", url: "https://x.test/2", body: "b" },
              ],
            },
          },
        ],
        usage: { input_tokens: 1400, output_tokens: 300 },
      },
    ]);

    const body = JSON.stringify({ nodes: [{ title: "v1" }, { title: "v2" }] });
    const result = await extractWithTools(
      {
        body,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(client),
    );

    expect(result.entries).toHaveLength(2);
    expect(result.toolRounds).toBe(1);
    expect(result.toolChars).toBeGreaterThan(0);
    expect(result.totalInput).toBe(2600);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `bun test packages/adapters/src/extract/extract-with-tools.test.ts`
Expected: the new test FAILS with the "expected extract_releases in round 1" error.

- [ ] **Step 3: Implement multi-round loop**

Replace the body of `extractWithTools` in `extract-with-tools.ts` (keep signature and result shape unchanged):

```ts
let totalInput = 0;
let totalOutput = 0;
let cacheReadTokens = 0;
let cacheWriteTokens = 0;
let toolRounds = 0;
let toolChars = 0;

while (toolRounds <= MAX_ROUNDS && toolChars < MAX_TOTAL_TOOL_CHARS) {
  const stream = deps.anthropicClient.messages.stream({
    model: deps.agentModel,
    max_tokens: 16_384,
    system: systemBlocks,
    tools,
    messages,
  });
  const response = await stream.finalMessage();

  totalInput += response.usage.input_tokens;
  totalOutput += response.usage.output_tokens;
  cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
  cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

  if (response.stop_reason === "max_tokens") {
    throw new LoopFallbackError("max_tokens");
  }

  const toolUses = response.content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );

  const terminal = toolUses.find((t) => t.name === "extract_releases");
  if (terminal) {
    const input = terminal.input as { releases: ExtractedEntry[] };
    return {
      entries: input.releases ?? [],
      totalInput,
      totalOutput,
      cacheReadTokens,
      cacheWriteTokens,
      toolRounds,
      toolChars,
      mode: preview.mode,
      hitMaxTokens: false,
    };
  }

  if (toolUses.length === 0) {
    throw new LoopFallbackError("no_terminal_call");
  }

  // Append the assistant turn and the tool_result blocks.
  messages.push({ role: "assistant", content: response.content });

  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  for (const tu of toolUses) {
    let resultText: string;
    try {
      if (tu.name === "get_slice") {
        resultText = handleGetSlice(opts.body, tu.input as { start: number; length: number });
      } else if (tu.name === "query_json") {
        resultText = handleQueryJson(opts.body, tu.input as { path: string });
      } else {
        throw new Error(`unknown tool: ${tu.name}`);
      }
    } catch (err) {
      throw new LoopFallbackError("tool_error", err as Error);
    }
    toolChars += resultText.length;
    toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultText });
  }

  messages.push({ role: "user", content: toolResults });
  toolRounds++;
}

throw new LoopFallbackError("max_rounds");
```

Also add at the top of the file:

```ts
export class LoopFallbackError extends Error {
  constructor(
    public readonly reason: UsageFallbackReason,
    public readonly cause?: Error,
  ) {
    super(`loop fallback: ${reason}`);
    this.name = "LoopFallbackError";
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test packages/adapters/src/extract/extract-with-tools.test.ts`
Expected: PASS for both happy-path and multi-round tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/extract/extract-with-tools.ts packages/adapters/src/extract/extract-with-tools.test.ts
git commit -m "feat(extract): multi-round tool-use loop with fallback errors"
```

---

## Task 11: Budget exhaustion — final "emit now" turn

**Files:**

- Modify: `packages/adapters/src/extract/extract-with-tools.ts`
- Modify: `packages/adapters/src/extract/extract-with-tools.test.ts`

- [ ] **Step 1: Write failing test — model keeps calling tools past budget, loop force-asks for extract_releases**

Append to `extract-with-tools.test.ts`:

```ts
describe("extractWithTools — budget exhaustion", () => {
  test("forces a final emit turn when MAX_ROUNDS reached", async () => {
    const keepQueryingResponse = {
      stop_reason: "tool_use" as const,
      content: [
        { type: "tool_use" as const, id: "tx", name: "get_slice", input: { start: 0, length: 10 } },
      ],
      usage: { input_tokens: 500, output_tokens: 50 },
    };
    const finalEmitResponse = {
      stop_reason: "tool_use" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "tfinal",
          name: "extract_releases",
          input: {
            releases: [
              { title: "v-last", publishedAt: "2026-04-01", url: "https://x.test/l", body: "x" },
            ],
          },
        },
      ],
      usage: { input_tokens: 600, output_tokens: 100 },
    };

    // 9 get_slice responses (exceeds MAX_ROUNDS of 8) + 1 final emit after the force-prompt.
    const client = mockAnthropicClient([
      ...Array.from({ length: 9 }, () => keepQueryingResponse),
      finalEmitResponse,
    ]);

    const result = await extractWithTools(
      {
        body: "abcdefghijkl",
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/",
      },
      makeDeps(client),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.toolRounds).toBe(8); // MAX_ROUNDS reached, then one force-emit round
  });

  test("throws max_rounds fallback when force-emit round still doesn't terminate", async () => {
    const keepQueryingResponse = {
      stop_reason: "tool_use" as const,
      content: [
        { type: "tool_use" as const, id: "tx", name: "get_slice", input: { start: 0, length: 10 } },
      ],
      usage: { input_tokens: 500, output_tokens: 50 },
    };
    const client = mockAnthropicClient(Array.from({ length: 10 }, () => keepQueryingResponse));

    await expect(
      extractWithTools(
        {
          body: "abcdefghij",
          systemPrompt: "test",
          userMessage: "Extract from:",
          sourceUrl: "https://x.test",
          fetchUrl: "https://x.test/",
        },
        makeDeps(client),
      ),
    ).rejects.toMatchObject({ name: "LoopFallbackError", reason: "max_rounds" });
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `bun test packages/adapters/src/extract/extract-with-tools.test.ts`
Expected: FAIL on the new tests — loop currently throws `max_rounds` immediately without the force-emit turn.

- [ ] **Step 3: Add the force-emit turn before throwing `max_rounds`**

In `extract-with-tools.ts`, replace the trailing `throw new LoopFallbackError("max_rounds")` with a final force-emit pass:

```ts
// Budget exhausted. Push a blunt instruction and allow ONE more round.
messages.push({
  role: "user",
  content:
    "You have used the maximum number of tool rounds. Do not call get_slice or query_json again. " +
    "Call extract_releases now with all the entries you have found.",
});

const forceStream = deps.anthropicClient.messages.stream({
  model: deps.agentModel,
  max_tokens: 16_384,
  system: systemBlocks,
  tools,
  messages,
});
const forceResp = await forceStream.finalMessage();
totalInput += forceResp.usage.input_tokens;
totalOutput += forceResp.usage.output_tokens;
cacheReadTokens += forceResp.usage.cache_read_input_tokens ?? 0;
cacheWriteTokens += forceResp.usage.cache_creation_input_tokens ?? 0;

const forceTerminal = forceResp.content.find(
  (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "extract_releases",
);
if (forceTerminal) {
  const input = forceTerminal.input as { releases: ExtractedEntry[] };
  return {
    entries: input.releases ?? [],
    totalInput,
    totalOutput,
    cacheReadTokens,
    cacheWriteTokens,
    toolRounds,
    toolChars,
    mode: preview.mode,
    hitMaxTokens: forceResp.stop_reason === "max_tokens",
  };
}

throw new LoopFallbackError("max_rounds");
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test packages/adapters/src/extract/extract-with-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/extract/extract-with-tools.ts packages/adapters/src/extract/extract-with-tools.test.ts
git commit -m "feat(extract): force-emit turn on MAX_ROUNDS exhaustion"
```

---

## Task 12: Prompt caching — moving breakpoint on most-recent tool_result

**Files:**

- Modify: `packages/adapters/src/extract/extract-with-tools.ts`
- Modify: `packages/adapters/src/extract/extract-with-tools.test.ts`

- [ ] **Step 1: Write a failing test that inspects the messages shape on the second round**

Append to `extract-with-tools.test.ts`:

```ts
describe("extractWithTools — prompt caching", () => {
  test("marks most-recent tool_result with cache_control on each new round", async () => {
    const captured: Anthropic.MessageCreateParams[] = [];
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        stream: ((params: Anthropic.MessageCreateParams) => {
          captured.push(params);
          const round = captured.length;
          if (round === 1) {
            return {
              finalMessage: async () =>
                ({
                  id: "m1",
                  type: "message",
                  role: "assistant",
                  model: "x",
                  content: [
                    {
                      type: "tool_use",
                      id: "t1",
                      name: "get_slice",
                      input: { start: 0, length: 5 },
                    },
                  ],
                  stop_reason: "tool_use",
                  stop_sequence: null,
                  usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                  },
                }) as Anthropic.Message,
            } as never;
          }
          return {
            finalMessage: async () =>
              ({
                id: "m2",
                type: "message",
                role: "assistant",
                model: "x",
                content: [
                  { type: "tool_use", id: "t2", name: "extract_releases", input: { releases: [] } },
                ],
                stop_reason: "tool_use",
                stop_sequence: null,
                usage: {
                  input_tokens: 100,
                  output_tokens: 10,
                  cache_read_input_tokens: 50,
                  cache_creation_input_tokens: 0,
                },
              }) as Anthropic.Message,
          } as never;
        }) as never,
      } as never,
    };

    await extractWithTools(
      {
        body: "abcdef",
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/",
      },
      makeDeps(client),
    );

    // Second call to stream() should include a tool_result block with cache_control set.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const round2 = captured[1]!;
    const lastUser = round2.messages[round2.messages.length - 1]!;
    expect(lastUser.role).toBe("user");
    const content = lastUser.content as Anthropic.ToolResultBlockParam[];
    const lastBlock = content[content.length - 1]!;
    expect(lastBlock.type).toBe("tool_result");
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `bun test packages/adapters/src/extract/extract-with-tools.test.ts`
Expected: FAIL — `cache_control` is not being set on tool_result blocks yet.

- [ ] **Step 3: Add the moving cache breakpoint**

In `extract-with-tools.ts`, just before the loop `while`, introduce a helper, and update the loop to move the breakpoint each round:

```ts
function stripCacheControlFromPrior(msgs: Anthropic.MessageParam[]): void {
  for (const msg of msgs) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if ("cache_control" in block) delete (block as { cache_control?: unknown }).cache_control;
    }
  }
}
```

Then, in the loop, when pushing `toolResults`, mark the LAST one with `cache_control` and strip prior markers so only one breakpoint is active at a time:

```ts
stripCacheControlFromPrior(messages);
if (toolResults.length > 0) {
  toolResults[toolResults.length - 1]!.cache_control = { type: "ephemeral" };
}
messages.push({ role: "user", content: toolResults });
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test packages/adapters/src/extract/extract-with-tools.test.ts`
Expected: PASS for all extract-with-tools tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/extract/extract-with-tools.ts packages/adapters/src/extract/extract-with-tools.test.ts
git commit -m "feat(extract): moving cache_control breakpoint across loop rounds"
```

---

## Task 13: Tier gate + fallback wiring in `extract-from-body.ts`

**Files:**

- Modify: `packages/adapters/src/extract/extract-from-body.ts`
- Modify: `packages/adapters/src/extract/types.ts`

- [ ] **Step 1: Extend `ExtractFromBodyResult` with telemetry fields**

In `types.ts` (or wherever `ExtractFromBodyResult` lives, currently `extract-from-body.ts:30-37`), add:

```ts
export interface ExtractFromBodyResult {
  entries: ExtractedEntry[];
  totalInput: number;
  totalOutput: number;
  hitMaxTokens: boolean;
  // New telemetry — populated for both one-shot and tool-loop paths.
  mode: UsageExtractionMode;
  toolRounds: number | null;
  toolChars: number | null;
  fallbackReason: UsageFallbackReason | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
```

- [ ] **Step 2: Wire tier gate + fallback in `extractFromBody`**

Replace the body of `extractFromBody` in `extract-from-body.ts`:

```ts
import { LoopFallbackError, extractWithTools } from "./extract-with-tools.js";
import {
  LARGE_BODY_TOKEN_THRESHOLD,
  MAX_BODY_CHARS_TOOLLOOP,
  // ...existing imports stay...
} from "./shared.js";

export async function extractFromBody(
  opts: ExtractFromBodyOpts,
  deps: ExtractDeps,
): Promise<ExtractFromBodyResult> {
  const { logger } = deps;

  const useToolLoop = opts.useToolLoop ?? false; // set by caller based on env var / source override
  const approxTokens = countTokensSafe(opts.body);

  // Tool-loop tier: cap at 2 MB, hand to extractWithTools.
  if (useToolLoop && approxTokens > LARGE_BODY_TOKEN_THRESHOLD) {
    const bodyForLoop =
      opts.body.length > MAX_BODY_CHARS_TOOLLOOP
        ? opts.body.slice(0, MAX_BODY_CHARS_TOOLLOOP) + "\n\n[Content truncated]"
        : opts.body;

    try {
      const result = await extractWithTools(
        {
          body: bodyForLoop,
          systemPrompt: opts.systemPrompt,
          userMessage: opts.userMessage,
          sourceUrl: opts.sourceUrl,
          fetchUrl: opts.fetchUrl,
          approxTokens,
        },
        deps,
      );
      return {
        entries: result.entries,
        totalInput: result.totalInput,
        totalOutput: result.totalOutput,
        hitMaxTokens: result.hitMaxTokens,
        mode: result.mode,
        toolRounds: result.toolRounds,
        toolChars: result.toolChars,
        fallbackReason: null,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
      };
    } catch (err) {
      const reason = err instanceof LoopFallbackError ? err.reason : "sdk_error";
      logger.warn(
        `tool-loop extraction fell back to one-shot: reason=${reason} sourceUrl=${opts.sourceUrl}`,
      );
      const oneshot = await runOneShot(opts, deps, approxTokens);
      return {
        ...oneshot,
        mode: "fallback_to_oneshot",
        toolRounds: null,
        toolChars: null,
        fallbackReason: reason,
      };
    }
  }

  // One-shot tier (unchanged behavior).
  const oneshot = await runOneShot(opts, deps, approxTokens);
  return {
    ...oneshot,
    mode: "oneshot",
    toolRounds: null,
    toolChars: null,
    fallbackReason: null,
  };
}
```

Extract the existing one-shot implementation into a `runOneShot` helper within the same file (moving the current `stream` call and `extract_releases` tool-use parsing into it, unchanged otherwise). It should return `{ entries, totalInput, totalOutput, hitMaxTokens, cacheReadTokens, cacheWriteTokens }`.

Also extend `ExtractFromBodyOpts` with:

```ts
  sourceUrl: string;
  fetchUrl: string;
  useToolLoop?: boolean;
```

- [ ] **Step 3: Update the two callers to pass `sourceUrl`, `fetchUrl`, `useToolLoop`**

In `run-direct-fetch.ts`, at the call site around line 107:

```ts
const result = await extractFromBody(
  {
    body,
    systemPrompt: DIRECT_FETCH_SYSTEM_PROMPT,
    userMessage: `Extract all changelog/release entries from this content (canonical source URL: ${source.url}, fetched from: ${opts.fetchUrl}):`,
    guidance: opts.guidance,
    sourceUrl: source.url,
    fetchUrl: opts.fetchUrl,
    useToolLoop:
      deps.config.extractToolLoopEnabled || source.metadata.extractStrategy === "toolloop",
  },
  deps,
);
```

Mirror the change in `run-agent.ts` (pass `source.url` for both `sourceUrl` and `fetchUrl`, since the scrape path doesn't have a distinct `fetchUrl`).

- [ ] **Step 4: Add `extractToolLoopEnabled` to the deps config shape**

Wherever `ExtractDeps.config` is typed, add:

```ts
extractToolLoopEnabled: boolean;
```

Wire it to an env var read in the worker entrypoints (`workers/api/src/index.ts`, `workers/discovery/src/managed-agents-session.ts` as applicable), reading `env.EXTRACT_TOOLLOOP_ENABLED === "true"`.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full extract-from-body test suite**

Run: `bun test packages/adapters/src/extract/`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/extract/extract-from-body.ts \
        packages/adapters/src/extract/types.ts \
        packages/adapters/src/extract/run-direct-fetch.ts \
        packages/adapters/src/extract/run-agent.ts \
        workers/
git commit -m "feat(extract): tier gate + fallback wiring in extract-from-body"
```

---

## Task 14: Populate new `usage_log` columns from callers

**Files:**

- Modify: `packages/adapters/src/extract/run-direct-fetch.ts:117`
- Modify: `packages/adapters/src/extract/run-agent.ts` (matching `logUsage` site)

- [ ] **Step 1: Extend the `logUsage` call in `run-direct-fetch.ts`**

Replace the current call:

```ts
await repo.logUsage({
  operation: "agent-ingest",
  model: agentModel,
  inputTokens: result.totalInput,
  outputTokens: result.totalOutput,
  sourceSlug: source.slug,
  releaseCount: result.entries.length,
  extractionMode: result.mode,
  toolRounds: result.toolRounds,
  toolChars: result.toolChars,
  fallbackReason: result.fallbackReason,
  cacheReadTokens: result.cacheReadTokens,
  cacheWriteTokens: result.cacheWriteTokens,
});
```

Add an `info` log line capturing the tier:

```ts
logger.info(
  `Extract mode=${result.mode} rounds=${result.toolRounds ?? "-"} toolChars=${result.toolChars ?? "-"} ` +
    `cacheRead=${result.cacheReadTokens} cacheWrite=${result.cacheWriteTokens} entries=${result.entries.length}`,
);
```

- [ ] **Step 2: Mirror the change in `run-agent.ts`**

Find the equivalent `logUsage` call in `run-agent.ts` and apply the same expansion.

- [ ] **Step 3: Update `repo.logUsage` to accept the new fields**

Find the `logUsage` method on the repo interface (likely `workers/api/src/repo.ts` or similar) and extend it to pass the new fields through to the insert. The Drizzle-inferred `NewUsageLog` type already includes them from Task 2.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/extract/run-direct-fetch.ts \
        packages/adapters/src/extract/run-agent.ts \
        workers/api/src/repo.ts
git commit -m "feat(extract): persist extraction-mode + cache tokens to usage_log"
```

---

## Task 15: Integration test — end-to-end fallback coverage

**Files:**

- Modify: `packages/adapters/src/extract/extract-with-tools.test.ts`

- [ ] **Step 1: Add a failing test asserting `tool_error` → LoopFallbackError**

```ts
describe("extractWithTools — fallback triggers", () => {
  test("tool handler throw triggers LoopFallbackError('tool_error')", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "query_json", input: { path: "??invalid??" } },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ]);

    await expect(
      extractWithTools(
        {
          body: JSON.stringify({ a: 1 }),
          systemPrompt: "test",
          userMessage: "Extract from:",
          sourceUrl: "https://x.test",
          fetchUrl: "https://x.test/feed.json",
        },
        makeDeps(client),
      ),
    ).rejects.toMatchObject({ name: "LoopFallbackError", reason: "tool_error" });
  });

  test("no_terminal_call fires when model emits text with no tool_use", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I don't know how to do this" }],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ]);

    await expect(
      extractWithTools(
        {
          body: JSON.stringify({ a: 1 }),
          systemPrompt: "test",
          userMessage: "Extract from:",
          sourceUrl: "https://x.test",
          fetchUrl: "https://x.test/feed.json",
        },
        makeDeps(client),
      ),
    ).rejects.toMatchObject({ name: "LoopFallbackError", reason: "no_terminal_call" });
  });

  test("max_tokens in a round fires LoopFallbackError('max_tokens')", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "max_tokens",
        content: [
          { type: "tool_use", id: "tx", name: "get_slice", input: { start: 0, length: 10 } },
        ],
        usage: { input_tokens: 500, output_tokens: 16_384 },
      },
    ]);

    await expect(
      extractWithTools(
        {
          body: "abcdefghij",
          systemPrompt: "test",
          userMessage: "Extract from:",
          sourceUrl: "https://x.test",
          fetchUrl: "https://x.test/",
        },
        makeDeps(client),
      ),
    ).rejects.toMatchObject({ name: "LoopFallbackError", reason: "max_tokens" });
  });
});
```

- [ ] **Step 2: Run tests — expect pass**

Run: `bun test packages/adapters/src/extract/extract-with-tools.test.ts`
Expected: All new tests PASS (these paths were implemented in Tasks 10 and 11).

- [ ] **Step 3: Full test + typecheck sweep**

Run:

```bash
bun test
npx tsc --noEmit
bun run lint
```

Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add packages/adapters/src/extract/extract-with-tools.test.ts
git commit -m "test(extract): fallback-trigger coverage for tool-loop"
```

---

## Task 16: Manual eval + rollout note

**Files:**

- Modify: `.env.example` (add `EXTRACT_TOOLLOOP_ENABLED=false` entry)
- Modify: `docs/superpowers/specs/2026-04-24-large-body-extract-tool-loop-design.md` (mark status as implemented)

- [ ] **Step 1: Document the env var**

Add to `.env.example`:

```dotenv
# Gate the tool-use loop for extraction of large bodies (>50K tokens).
# Default false preserves the legacy one-shot path.
EXTRACT_TOOLLOOP_ENABLED=false
```

- [ ] **Step 2: Update spec status**

Change the header line in `docs/superpowers/specs/2026-04-24-large-body-extract-tool-loop-design.md`:

```md
**Status:** Implemented — pending eval-based rollout
```

- [ ] **Step 3: Run the PostHog fixture eval manually**

(Per AGENTS.md, evals are on-demand and cost money. This is a one-time calibration run.)

Run:

```bash
EXTRACT_TOOLLOOP_ENABLED=true bun run eval:evaluation -- --fixture .context/examples/page-data.json
```

Note: the eval script `eval:evaluation` targets URL evaluation, not extraction. If no existing eval runner fits, construct a one-off harness in a scratch file (not committed) that loads the fixture, calls `extractFromBody({ useToolLoop: true, ... })`, and prints `totalInput`, `totalOutput`, `toolRounds`, `cacheReadTokens`. Compare to the baseline 155K input / $0.65 cost.

Expected: input tokens drop meaningfully (target: <30K per extraction), cost drops to <$0.10 per extraction.

- [ ] **Step 4: Commit**

```bash
git add .env.example docs/superpowers/specs/2026-04-24-large-body-extract-tool-loop-design.md
git commit -m "chore(extract): document EXTRACT_TOOLLOOP_ENABLED and mark spec implemented"
```

- [ ] **Step 5: Open PR**

Run:

```bash
git push -u origin feat/extract-tool-loop
gh pr create --title "feat(extract): tool-use loop for large bodies" --body-file /tmp/extract-toolloop-pr-body.md
```

Draft the PR body (write to `/tmp/extract-toolloop-pr-body.md` first) covering: the 155K → <30K token reduction target, the hard fallback guarantee, the rollout plan (env var off by default → enable per-source → flip global), and a pointer to the spec.

---

## Summary

- 16 tasks, each bite-sized with test-first cycles and a commit at the end.
- Phase 1 (Tasks 1–2): dependencies + schema migration.
- Phase 2 (Tasks 3–8): pure helpers (preview builder, tool handlers), fully testable in isolation.
- Phase 3 (Tasks 9–12): loop controller with progressively richer behavior (happy path → multi-round → budget exhaustion → caching).
- Phase 4 (Tasks 13–14): integration with `extract-from-body.ts`, feature flag, observability.
- Phase 5 (Tasks 15–16): fallback coverage + manual eval + rollout PR.

Every commit should leave the tree in a passing state (`bun test` green, `npx tsc --noEmit` green).
