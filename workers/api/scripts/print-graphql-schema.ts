#!/usr/bin/env bun
/**
 * Print the GraphQL SDL to packages/api-types/graphql/schema.graphql.
 * Run after editing any GraphQL type/resolver so codegen consumers (web/)
 * pick up the wire change. The file is committed — a forgotten regen surfaces
 * as a PR diff rather than a runtime mismatch.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printSchema, lexicographicSortSchema } from "graphql";
import { schema } from "../src/graphql/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../packages/api-types/graphql/schema.graphql");

mkdirSync(dirname(out), { recursive: true });
const sdl = printSchema(lexicographicSortSchema(schema));
const banner = `# GENERATED — do not edit by hand.\n# Regenerate with: bun workers/api/scripts/print-graphql-schema.ts\n\n`;
writeFileSync(out, banner + sdl + "\n");

console.log(`Wrote ${out}`);
