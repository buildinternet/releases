#!/usr/bin/env bun
// Generates the public JSON Schema for releases.json from the api-types zod
// source of truth (zod 4 native z.toJSONSchema). Run: bun run gen:releases-schema
//
// Risk notes:
// - avatar uses `.refine()` which zod 4's toJSONSchema silently drops (it is
//   unrepresentable in JSON Schema). The generated schema still carries the
//   format:"uri" constraint from z.url(); the runtime zod still enforces https.
//   No special option needed — zod 4 already silently omits refine predicates.
// - NoticeSchema has two .refine() calls (coordinate XOR href, valid coordinate
//   pattern); same treatment — silently dropped, runtime still enforces them.
// - Output is formatted with the repo's prettier config before writing so that
//   re-running gen produces an identical file even after the pre-commit
//   prettier hook has run (idempotency guarantee for the CI diff check).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import prettier from "prettier";
import { ReleasesJsonConfigSchema } from "../packages/api-types/src/schemas/well-known.js";

const OUT = join(import.meta.dir, "..", "web", "public", "schemas", "releases.json");

const base = z.toJSONSchema(ReleasesJsonConfigSchema, { target: "draft-2020-12" });
// .strip() (top-level) silently drops unknown keys at runtime rather than rejecting
// them, but z.toJSONSchema emits additionalProperties:false for it. Remove the
// top-level constraint so the published schema doesn't flag forward-compat keys.
// (The inner product schema is .strict(), so its additionalProperties:false stays.)
delete (base as Record<string, unknown>).additionalProperties;
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://releases.sh/schemas/releases.json",
  title: "releases.json configuration",
  description:
    "Owner-declared listing metadata for the Releases registry. Host at " +
    "https://{domain}/.well-known/releases.json (org identity) or in a repo root " +
    "as releases.json (that source's product mapping).",
  ...base,
};

const raw = JSON.stringify(schema, null, 2) + "\n";
const prettierConfig = await prettier.resolveConfig(import.meta.dir);
const formatted = await prettier.format(raw, { parser: "json", ...prettierConfig });

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, formatted);
console.log(`wrote ${OUT}`);
