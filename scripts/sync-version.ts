#!/usr/bin/env bun
// Runs after `changeset version`. Mirrors the bumped version from
// npm/releases/package.json (the source of truth for the published CLI)
// back to the places the build needs it:
//   - root package.json (displayed by `releases --version`)
//   - src/cli/program.ts (compiled into the binary)
//   - src/mcp/server.ts (MCP server identifier)
// The Homebrew formula lives in the public tap repo
// (buildinternet/homebrew-tap) and is regenerated on publish by CI —
// not by this script.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const newVersion = JSON.parse(
  readFileSync(join(ROOT, "npm/releases/package.json"), "utf8"),
).version as string;

function updateJson(path: string, mutate: (j: Record<string, unknown>) => void) {
  const full = join(ROOT, path);
  const j = JSON.parse(readFileSync(full, "utf8"));
  mutate(j);
  writeFileSync(full, JSON.stringify(j, null, 2) + "\n");
  console.log(`  ✓ ${path}`);
}

function replaceInFile(path: string, pattern: RegExp, replacement: string) {
  const full = join(ROOT, path);
  if (!existsSync(full)) return;
  const before = readFileSync(full, "utf8");
  const after = before.replace(pattern, replacement);
  if (before === after) {
    console.log(`  ⊘ ${path} (no match)`);
    return;
  }
  writeFileSync(full, after);
  console.log(`  ✓ ${path}`);
}

console.log(`Syncing version → ${newVersion}`);

updateJson("package.json", (j) => {
  j.version = newVersion;
});

replaceInFile("src/cli/program.ts", /VERSION = "[^"]+"/, `VERSION = "${newVersion}"`);
replaceInFile("src/mcp/server.ts", /version: "[^"]+"/, `version: "${newVersion}"`);

console.log("Done.");
