import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_REVALIDATE_SECONDS, ISR_REVALIDATE_FLOOR_SECONDS } from "./isr.js";

/**
 * Guard for the trap that silently neutralized #2004 for three weeks.
 *
 * A statically-rendered route's regeneration period is the MIN of its
 * `export const revalidate` and EVERY fetch revalidate in its render tree —
 * layouts included. A single `next: { revalidate: 60 }` reached from the root
 * layout therefore caps the whole site at 60s no matter what the page-level
 * literals say. Nothing breaks; the pages just regenerate ~1400x/day and the
 * only symptom is the Vercel ISR-write line item.
 *
 * So walk the actual import graph from `app/layout.tsx` and assert nothing in
 * it caches below the floor. A flat scan over `src/` would be wrong in both
 * directions: it would flag route handlers that legitimately cache their own
 * upstream for an hour, and it would still miss the layout-reachability that is
 * the whole point.
 */

const SRC_DIR = resolve(import.meta.dir, "..");
const ROOT_LAYOUT = join(SRC_DIR, "app", "layout.tsx");

/**
 * `next: { revalidate: <expr> }` — the fetch-option form, not `export const
 * revalidate`. Captures the whole expression rather than just digits: the
 * codebase writes these as named constants (`github-star.tsx`), and a
 * digits-only pattern would skip exactly the files this guard exists to watch.
 */
const FETCH_REVALIDATE = /next:\s*\{[^}]*?\brevalidate:\s*([^,}\s]+)/gs;

/**
 * Identifiers this guard can evaluate, resolved to their real values — so
 * lowering `DEFAULT_REVALIDATE_SECONDS` itself trips the guard rather than
 * sliding past it. Anything not listed here is treated as an offender, not
 * waved through: a symbol we cannot evaluate is exactly the blind spot that
 * makes a green guard misleading.
 */
const RESOLVABLE: Record<string, number> = {
  DEFAULT_REVALIDATE_SECONDS,
  ISR_REVALIDATE_FLOOR_SECONDS,
};

/** Offending `revalidate` expressions in one file's text. */
export function revalidateOffenders(text: string, label: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(FETCH_REVALIDATE)) {
    const expr = match[1]!.trim();

    // `false` means cache indefinitely — it can never lower a route's window.
    if (expr === "false") continue;

    if (/^\d[\d_]*$/.test(expr)) {
      const seconds = Number(expr.replace(/_/g, ""));
      if (seconds < ISR_REVALIDATE_FLOOR_SECONDS) out.push(`${label}: revalidate: ${expr}`);
      continue;
    }

    if (expr in RESOLVABLE) {
      const seconds = RESOLVABLE[expr]!;
      if (seconds < ISR_REVALIDATE_FLOOR_SECONDS) {
        out.push(`${label}: revalidate: ${expr} (= ${seconds})`);
      }
      continue;
    }

    out.push(
      `${label}: revalidate: ${expr} (unresolved — add it to RESOLVABLE or inline a literal)`,
    );
  }
  return out;
}

/** Resolve an import specifier to a file under `src/`, or null if it leaves the tree. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC_DIR, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null; // bare package — not our code

  const withoutJs = base.replace(/\.js$/, "");
  for (const candidate of [
    `${withoutJs}.tsx`,
    `${withoutJs}.ts`,
    join(withoutJs, "index.tsx"),
    join(withoutJs, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT_SPECIFIER = /(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/gs;

/** Every first-party module reachable from the root layout. */
function layoutImportGraph(): string[] {
  const seen = new Set<string>();
  const queue = [ROOT_LAYOUT];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT_SPECIFIER)) {
      const next = resolveLocal(match[1]!, file);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen];
}

describe("revalidateOffenders", () => {
  it("flags a numeric literal below the floor", () => {
    expect(revalidateOffenders("fetch(u, { next: { revalidate: 60 } })", "f.ts")).toEqual([
      "f.ts: revalidate: 60",
    ]);
  });

  it("allows a numeric literal at the floor", () => {
    const text = `fetch(u, { next: { revalidate: ${ISR_REVALIDATE_FLOOR_SECONDS} } })`;
    expect(revalidateOffenders(text, "f.ts")).toEqual([]);
  });

  it("allows revalidate: false, which can never lower a route's window", () => {
    expect(revalidateOffenders("fetch(u, { next: { revalidate: false } })", "f.ts")).toEqual([]);
  });

  it("allows a resolvable constant that sits at the floor", () => {
    const text = "fetch(u, { next: { revalidate: DEFAULT_REVALIDATE_SECONDS } })";
    expect(revalidateOffenders(text, "f.ts")).toEqual([]);
  });

  // The regression that motivated this: `github-star.tsx` writes its window as a
  // named constant, so a digits-only guard silently skipped the very file it was
  // added to watch. An unevaluable symbol must fail, not pass.
  it("flags an unresolvable identifier rather than skipping it", () => {
    const out = revalidateOffenders("fetch(u, { next: { revalidate: SOME_OTHER_CONST } })", "f.ts");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("unresolved");
  });

  it("flags a numeric-separator literal below the floor", () => {
    expect(revalidateOffenders("fetch(u, { next: { revalidate: 3_600 } })", "f.ts")).toEqual([
      "f.ts: revalidate: 3_600",
    ]);
  });
});

describe("ISR revalidate floor", () => {
  // `applyCacheInit` (lib/api.ts) hands DEFAULT_REVALIDATE_SECONDS to every API
  // read, including the site-notice fetch in the root layout — but it writes
  // `.next = ... { revalidate: X }` through a variable, which the source scan
  // above cannot see. Lowering the default would therefore re-cap the entire
  // site with the graph scan still green. Assert the invariant directly.
  it("keeps the shared default at or above the floor", () => {
    expect(DEFAULT_REVALIDATE_SECONDS).toBeGreaterThanOrEqual(ISR_REVALIDATE_FLOOR_SECONDS);
  });

  it("reaches the root layout at all", () => {
    // Cheap canary: a rename that breaks path resolution would otherwise make
    // the real assertion below vacuously pass over an empty graph.
    const graph = layoutImportGraph();
    expect(graph).toContain(ROOT_LAYOUT);
    expect(graph.length).toBeGreaterThan(10);
  });

  it("caches nothing below the floor in the root-layout import graph", () => {
    const offenders = layoutImportGraph().flatMap((file) =>
      revalidateOffenders(readFileSync(file, "utf8"), file.slice(SRC_DIR.length + 1)),
    );

    expect(offenders).toEqual([]);
  });
});
