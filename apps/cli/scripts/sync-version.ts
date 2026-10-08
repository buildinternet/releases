#!/usr/bin/env bun
// Runs after `changeset version`. Mirrors the bumped version from
// npm/releases/package.json (the source of truth for the published CLI)
// back to the places the build needs it:
//   - src/cli/version.ts (compiled into the binary; also re-exported
//     as the MCP server identifier via src/mcp/server.ts)
//   - npm/releases-*/package.json (platform packages)
// The Homebrew formula lives in the public tap repo
// (buildinternet/homebrew-tap) and is regenerated on publish by CI —
// not by this script.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

const newVersion = JSON.parse(readFileSync(join(ROOT, "npm/releases/package.json"), "utf8"))
  .version as string;

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

// apps/cli/package.json (@releases/cli) is a private workspace package and is
// deliberately NOT synced: changesets/action reads <pkg>/CHANGELOG.md for every
// workspace package whose version changed when it builds the version PR body,
// and private packages have no changelog. It stays at 0.0.0 like the other
// private workspaces; `releases --version` reads src/cli/version.ts.

// Platform npm packages — keep in sync with meta package optionalDependencies
for (const pkg of [
  "npm/releases-darwin-arm64/package.json",
  "npm/releases-darwin-x64/package.json",
  "npm/releases-linux-x64/package.json",
  "npm/releases-linux-arm64/package.json",
  "npm/releases-windows-x64/package.json",
]) {
  updateJson(pkg, (j) => {
    j.version = newVersion;
  });
}

// Also update optionalDependencies in the meta package to match
updateJson("npm/releases/package.json", (j) => {
  const optDeps = j.optionalDependencies as Record<string, string> | undefined;
  if (optDeps) {
    for (const key of Object.keys(optDeps)) {
      optDeps[key] = newVersion;
    }
  }
});

// CLI version.ts — single TypeScript source of truth. src/mcp/server.ts
// imports VERSION from this file, so no separate write needed.
replaceInFile("src/cli/version.ts", /VERSION = "[^"]+"/, `VERSION = "${newVersion}"`);

console.log("Done.");
