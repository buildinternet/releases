import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard for the dark-mode flash that regressed three times (#145, #1156, #1634,
 * fixed in #2411).
 *
 * The theme bootstrap must run while the document is parsed, before first
 * paint. `next/script` with `strategy="beforeInteractive"` looks like it does
 * that, but in the App Router it is emitted as a `self.__next_s` queue entry
 * that only runs once the async runtime chunks load — after first paint — so
 * every `dark:` utility flashes light. It went unnoticed for months because a
 * server-read theme cookie was doing the real work; removing the cookie for ISR
 * exposed it. The only safe shape is a plain inline `<script>` in `<head>`.
 */

const LAYOUT_SOURCE = readFileSync(join(import.meta.dir, "layout.tsx"), "utf8");

// The layout's comments explain the beforeInteractive trap by name, so match
// against code only. Crude (a `//` inside a string is dropped too), but the
// assertions below only look for JSX attributes, never string contents.
const LAYOUT_CODE = LAYOUT_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function headJsx(source: string): string {
  const start = source.indexOf("<head>");
  const end = source.indexOf("</head>");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("root layout has no <head>…</head> block");
  }
  return source.slice(start, end);
}

describe("root layout theme bootstrap", () => {
  it("renders THEME_SCRIPT as a plain inline <script> inside <head>", () => {
    const head = headJsx(LAYOUT_CODE);
    expect(head).toMatch(/<script\b[^>]*\bid="theme-bootstrap"/);
    expect(head).toMatch(/dangerouslySetInnerHTML=\{\{\s*__html:\s*THEME_SCRIPT\s*\}\}/);
  });

  it("never uses next/script's beforeInteractive strategy", () => {
    // Deferred in the App Router: runs after first paint, not before.
    expect(LAYOUT_CODE).not.toMatch(/beforeInteractive/);
    expect(LAYOUT_CODE).not.toMatch(/<Script\b[^>]*theme-bootstrap/);
  });
});
