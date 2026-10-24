import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { PUBLIC_OPERATIONS } from "../../apps/api/src/api-surface.js";

// The SDK names each call by its API surface key ("GET /orgs/:slug"). Every
// key it uses must be a public operation: internal routes are not a
// contract and can change without notice.
const source = readFileSync(new URL("../../packages/sdk/src/client.ts", import.meta.url), "utf8");
const used = [...source.matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]*)"/g)].map((m) => m[1]!);

describe("SDK public surface", () => {
  test("finds the operations the client calls", () => {
    expect(used.length).toBeGreaterThan(30);
  });

  test("calls only public operations", () => {
    expect(used.filter((op) => !(op in PUBLIC_OPERATIONS))).toEqual([]);
  });
});
