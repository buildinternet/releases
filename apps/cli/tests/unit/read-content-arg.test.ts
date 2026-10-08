import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContentArg } from "../../src/lib/input.js";
import { InvalidInputError, CliError } from "../../src/lib/errors.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readContentArg", () => {
  it("reads a file's contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rel-rca-"));
    dirs.push(dir);
    const file = join(dir, "body.json");
    writeFileSync(file, '{"ok":true}');
    expect(await readContentArg(file)).toBe('{"ok":true}');
  });

  // Throws (does not process.exit) so the failure reaches the top-level handler
  // and gets serialized to the structured `{ error }` payload under `--json`.
  it("throws InvalidInputError on a traversal path", async () => {
    await expect(readContentArg("../../etc/passwd")).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("throws CliError (not InvalidInputError) on an unreadable file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rel-rca-"));
    dirs.push(dir);
    const missing = join(dir, "does-not-exist.json");
    const err = await readContentArg(missing).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).not.toBeInstanceOf(InvalidInputError);
    expect((err as CliError).message).toMatch(/cannot read file/);
  });
});
