import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReleasesJsonConfigSchema } from "@buildinternet/releases-api-types";

// releases.sh dogfoods the owner-declared listing standard it documents at
// /docs/listing: this is the org-identity file the daily sweep reads from
// https://releases.sh/.well-known/releases.json. Keep it schema-valid.
describe("public/.well-known/releases.json", () => {
  // Resolve relative to this test file — the root `bun test` runs from the
  // repo root, not web/, so process.cwd() would point at the wrong tree.
  const raw = readFileSync(
    join(import.meta.dir, "..", "public", ".well-known", "releases.json"),
    "utf8",
  );

  it("is valid JSON and conforms to the published releases.json schema", () => {
    const parsed = JSON.parse(raw);
    expect(() => ReleasesJsonConfigSchema.parse(parsed)).not.toThrow();
  });

  it("points $schema at the canonical published schema", () => {
    const parsed = ReleasesJsonConfigSchema.parse(JSON.parse(raw));
    expect(parsed.$schema).toBe("https://releases.sh/schemas/releases.json");
  });
});
