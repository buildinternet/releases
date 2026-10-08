import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonInputArg } from "../../src/lib/input.js";
import { InvalidInputError, CliError } from "../../src/lib/errors.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readJsonInputArg", () => {
  it("parses a literal JSON object", async () => {
    expect(await readJsonInputArg('{"name":"Astro","type":"scrape"}')).toEqual({
      name: "Astro",
      type: "scrape",
    });
  });

  it("parses a literal JSON array (callers decide whether arrays are valid)", async () => {
    expect(await readJsonInputArg("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("reads and parses a file via the @<path> sigil", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rel-rjia-"));
    dirs.push(dir);
    const file = join(dir, "body.json");
    writeFileSync(file, '{"url":"https://example.com/changelog"}');
    expect(await readJsonInputArg(`@${file}`)).toEqual({
      url: "https://example.com/changelog",
    });
  });

  it("reads and parses the body from stdin when value is '-'", async () => {
    const originalStdinText = Bun.stdin.text;
    (Bun.stdin as { text: () => Promise<string> }).text = async () =>
      '{"name":"FromStdin","url":"https://example.com/changelog"}';
    try {
      expect(await readJsonInputArg("-")).toEqual({
        name: "FromStdin",
        url: "https://example.com/changelog",
      });
    } finally {
      (Bun.stdin as { text: () => Promise<string> }).text = originalStdinText;
    }
  });

  // A literal JSON value never begins with `@`, so the file sigil is unambiguous.
  it("does not treat a leading-brace literal as a path", async () => {
    expect(await readJsonInputArg('{"@weird":"ok"}')).toEqual({ "@weird": "ok" });
  });

  it("throws CliError on invalid JSON (so it serializes under --json)", async () => {
    const err = await readJsonInputArg("{not json").catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/not valid JSON/);
  });

  it("propagates the traversal guard when @<path> escapes via ..", async () => {
    await expect(readJsonInputArg("@../../etc/passwd")).rejects.toBeInstanceOf(InvalidInputError);
  });
});
