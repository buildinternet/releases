#!/usr/bin/env bun
/**
 * Sync agent skills into the Claude Code plugin directory.
 *
 * Copies SKILL.md files from src/agent/skills/ to plugins/claude/releases/skills/,
 * prepending an auto-generated header to each copy. The plugin directory stays
 * self-contained and committable while the source of truth remains in src/agent/skills/.
 *
 * Usage:
 *   bun scripts/sync-plugin-skills.ts            # sync all skills
 *   bun scripts/sync-plugin-skills.ts --dry-run  # preview without changes
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import { resolve, join } from "path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SOURCE_SKILLS_DIR = resolve(PROJECT_ROOT, "src/agent/skills");
const PLUGIN_SKILLS_DIR = resolve(PROJECT_ROOT, "plugins/claude/releases/skills");

const AUTO_GEN_COMMENT =
  "<!-- AUTO-GENERATED: Do not edit directly. Source of truth is src/agent/skills/. Changes here will be overwritten by scripts/sync-plugin-skills.ts -->";

const PLUGIN_ONLY_SKILLS = new Set(["releases-mcp"]);

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

    // Insert comment after frontmatter so YAML parsing isn't broken
    const fmEnd = sourceContent.indexOf("---", 3);
    const destContent = fmEnd !== -1
      ? sourceContent.slice(0, fmEnd + 3) + "\n\n" + AUTO_GEN_COMMENT + "\n" + sourceContent.slice(fmEnd + 3)
      : AUTO_GEN_COMMENT + "\n\n" + sourceContent;

    if (existsSync(destPath) && readFileSync(destPath, "utf8") === destContent) {
      console.log(`  ✓ ${dirName} — up to date`);
      unchanged++;
      continue;
    }

    console.log(`  ↻ ${dirName} — syncing`);
    synced++;

    if (!dryRun) {
      mkdirSync(destDir, { recursive: true });
      writeFileSync(destPath, destContent);
    }
  }

  let removed = 0;

  if (existsSync(PLUGIN_SKILLS_DIR)) {
    const pluginDirs = readdirSync(PLUGIN_SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => !PLUGIN_ONLY_SKILLS.has(d.name))
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

main();
