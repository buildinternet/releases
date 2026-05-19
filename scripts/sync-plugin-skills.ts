#!/usr/bin/env bun
/**
 * Sync agent skills into the Claude Code plugin directory.
 *
 * Source of truth lives in src/agent/skills/ — managed agents read from there
 * directly. The plugin tree at plugins/claude/releases/skills/ is a generated
 * mirror, kept self-contained and committable so Claude Code clients see the
 * same content without needing a build step.
 *
 * Every skill in src/agent/skills/ is mirrored. Even skills that are
 * primarily invoked by managed agents (regenerating overviews, parsing
 * pipeline helpers, etc.) belong in the plugin cache: Claude Code sessions
 * routinely dispatch sub-agents that need to find them, and the Skill tool
 * only surfaces a skill when its description matches user intent — so an
 * irrelevant skill in the cache is invisible, not clutter. The pre-fix
 * "agent-only exclusion" was the root cause of issue #1083.
 *
 * Usage:
 *   bun scripts/sync-plugin-skills.ts            # sync all skills
 *   bun scripts/sync-plugin-skills.ts --dry-run  # preview without changes
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
  cpSync,
} from "fs";
import { resolve, join } from "path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SOURCE_SKILLS_DIR = resolve(PROJECT_ROOT, "src/agent/skills");
const PLUGIN_SKILLS_DIR = resolve(PROJECT_ROOT, "plugins/claude/releases/skills");

const AUTO_GEN_COMMENT =
  "<!-- AUTO-GENERATED: Do not edit directly. Source of truth is src/agent/skills/. Changes here will be overwritten by scripts/sync-plugin-skills.ts -->";

function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) console.log("DRY RUN — no changes will be made\n");

  const skillDirs = readdirSync(SOURCE_SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(SOURCE_SKILLS_DIR, d.name, "SKILL.md")))
    .map((d) => d.name);

  console.log(`Found ${skillDirs.length} skill(s) in ${SOURCE_SKILLS_DIR}\n`);

  let synced = 0;
  let unchanged = 0;

  for (const dirName of skillDirs) {
    const sourcePath = join(SOURCE_SKILLS_DIR, dirName, "SKILL.md");
    const destDir = join(PLUGIN_SKILLS_DIR, dirName);
    const destPath = join(destDir, "SKILL.md");

    const sourceContent = readFileSync(sourcePath, "utf8");

    // Insert the auto-gen comment immediately after the frontmatter so the
    // mirrored file ends up with a single blank line between `---` and the
    // comment, and a single blank line between the comment and the body —
    // matching what prettier would otherwise produce. Without this, the
    // CI drift guard fights with `prettier --write`.
    const fmEnd = sourceContent.indexOf("---", 3);
    const destContent =
      fmEnd !== -1
        ? sourceContent.slice(0, fmEnd + 3) +
          "\n\n" +
          AUTO_GEN_COMMENT +
          sourceContent.slice(fmEnd + 3)
        : AUTO_GEN_COMMENT + "\n\n" + sourceContent;

    const sourceRefs = join(SOURCE_SKILLS_DIR, dirName, "references");
    const destRefs = join(destDir, "references");
    const refsInSync = refsEqual(sourceRefs, destRefs);

    if (existsSync(destPath) && readFileSync(destPath, "utf8") === destContent && refsInSync) {
      console.log(`  ✓ ${dirName} — up to date`);
      unchanged++;
      continue;
    }

    console.log(`  ↻ ${dirName} — syncing`);
    synced++;

    if (!dryRun) {
      mkdirSync(destDir, { recursive: true });
      writeFileSync(destPath, destContent);

      if (existsSync(destRefs)) rmSync(destRefs, { recursive: true, force: true });
      if (existsSync(sourceRefs)) cpSync(sourceRefs, destRefs, { recursive: true });
    }
  }

  let removed = 0;

  if (existsSync(PLUGIN_SKILLS_DIR)) {
    const pluginDirs = readdirSync(PLUGIN_SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => !skillDirs.includes(d.name));

    for (const orphan of pluginDirs) {
      console.log(`  ✗ ${orphan.name} — removing (no longer in source)`);
      removed++;
      if (!dryRun) {
        rmSync(join(PLUGIN_SKILLS_DIR, orphan.name), { recursive: true });
      }
    }
  }

  console.log(`\nDone: ${synced} synced, ${unchanged} unchanged, ${removed} removed`);
}

function refsEqual(sourceDir: string, destDir: string): boolean {
  const hasSource = existsSync(sourceDir);
  const hasDest = existsSync(destDir);
  if (!hasSource && !hasDest) return true;
  if (hasSource !== hasDest) return false;

  const sourceFiles = readdirSync(sourceDir).toSorted();
  const destFiles = readdirSync(destDir).toSorted();
  if (sourceFiles.length !== destFiles.length) return false;

  for (let i = 0; i < sourceFiles.length; i++) {
    if (sourceFiles[i] !== destFiles[i]) return false;
    const a = readFileSync(join(sourceDir, sourceFiles[i]), "utf8");
    const b = readFileSync(join(destDir, destFiles[i]), "utf8");
    if (a !== b) return false;
  }
  return true;
}

main();
