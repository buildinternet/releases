#!/usr/bin/env bun
// Regenerates the flag reference table in docs/architecture/feature-flags.md
// from the FLAGS registry (@releases/lib/flags). Run: bun run flags:docs
//
// The table is spliced between the GENERATED markers, then the whole file is
// run through oxfmt so the output is byte-identical to what the pre-commit hook
// (and `flags-docs.test.ts`) produce — the same idempotency approach as
// gen-releases-schema.ts. A stale table fails the drift test.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderFlagsDocTable, spliceFlagsDoc } from "../packages/lib/src/flags-docs.js";

const DOC = join(import.meta.dir, "..", "docs", "architecture", "feature-flags.md");

const spliced = spliceFlagsDoc(readFileSync(DOC, "utf8"), renderFlagsDocTable());
writeFileSync(DOC, spliced);

const format = spawnSync("bunx", ["oxfmt", "--write", DOC], { stdio: "inherit" });
if (format.status !== 0) process.exit(format.status ?? 1);

console.log(`wrote ${DOC}`);
