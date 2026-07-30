import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ISR_REVALIDATE_FLOOR_SECONDS } from "./isr.js";

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
 * upstream for an hour, and it would still miss the layout-reachability that
 * is the whole point.
 */

const SRC_DIR = resolve(import.meta.dir, "..");
const ROOT_LAYOUT = join(SRC_DIR, "app", "layout.tsx");

/** `next: { revalidate: <number> }` — the fetch-option form, not `export const revalidate`. */
const FETCH_REVALIDATE = /next:\s*\{[^}]*?\brevalidate:\s*(\d+)/gs;
const IMPORT_SPECIFIER = /(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/gs;

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

describe("ISR revalidate floor", () => {
  it("reaches the root layout at all", () => {
    // Cheap canary: a rename that breaks path resolution would otherwise make
    // the real assertion below vacuously pass over an empty graph.
    const graph = layoutImportGraph();
    expect(graph).toContain(ROOT_LAYOUT);
    expect(graph.length).toBeGreaterThan(10);
  });

  it("caches nothing below the floor in the root-layout import graph", () => {
    const offenders: string[] = [];

    for (const file of layoutImportGraph()) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(FETCH_REVALIDATE)) {
        const seconds = Number(match[1]);
        if (seconds < ISR_REVALIDATE_FLOOR_SECONDS) {
          offenders.push(`${file.slice(SRC_DIR.length + 1)}: revalidate: ${seconds}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
