import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { PUBLIC_OPERATIONS } from "../../apps/api/src/api-surface.js";

// The SDK names each call by its API surface key ("GET /orgs/:slug"), and so
// does the CLI where it sends an operation the SDK has no method for. Every
// key either uses must be a public operation: internal routes are not a
// contract and can change without notice.
const OPERATION = /"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]*)"/g;

function operationsIn(dir: URL, files: string[]): string[] {
  return files.flatMap((file) =>
    [...readFileSync(new URL(file, dir), "utf8").matchAll(OPERATION)].map((m) => m[1]!),
  );
}

const sdk = operationsIn(new URL("../../packages/sdk/src/", import.meta.url), ["client.ts"]);
const cliDir = new URL("../../apps/cli/src/api/", import.meta.url);
const cli = operationsIn(
  cliDir,
  readdirSync(cliDir).filter((f) => f.endsWith(".ts")),
);

describe("SDK public surface", () => {
  test("finds the operations the SDK and CLI call", () => {
    expect(sdk.length).toBeGreaterThan(30);
    expect(cli.length).toBeGreaterThan(0);
  });

  test("calls only public operations", () => {
    expect([...sdk, ...cli].filter((op) => !(op in PUBLIC_OPERATIONS))).toEqual([]);
  });
});
