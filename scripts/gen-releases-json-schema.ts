#!/usr/bin/env bun
// Generates the public JSON Schema for releases.json from the api-types zod
// source of truth (zod 4 native z.toJSONSchema). Run: bun run gen:releases-schema
//
// Risk note: runtime refinements (HTTPS-only locators, canonical/total caps) are
// unrepresentable in JSON Schema and are silently omitted by zod 4. Structural
// locator and array caps remain represented in the generated schema.
// - Output is formatted with the repo's oxfmt config before writing so that
//   re-running gen produces an identical file even after the pre-commit
//   oxfmt hook has run (idempotency guarantee for the CI diff check).
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ReleasesJsonConfigSchema } from "../packages/api-types/src/schemas/well-known.js";

const OUT = join(import.meta.dir, "..", "web", "public", "schemas", "releases.json");

const base = z.toJSONSchema(ReleasesJsonConfigSchema, { target: "draft-2020-12" });
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://releases.sh/schemas/releases.json",
  title: "releases.json v2 manifest",
  description:
    "Owner-declared products and release locations. Host at " +
    "https://{domain}/.well-known/releases.json (org scope) or in a repository root " +
    "as releases.json (repository scope).",
  ...base,
};

const raw = JSON.stringify(schema, null, 2) + "\n";

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, raw);

const format = spawnSync("bunx", ["oxfmt", "--write", OUT], { stdio: "inherit" });
if (format.status !== 0) {
  process.exit(format.status ?? 1);
}

console.log(`wrote ${OUT}`);
