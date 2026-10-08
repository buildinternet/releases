import { describe, it, expect } from "bun:test";
import { promptConfirm, type PromptReader } from "../../src/lib/confirm.js";

const QUESTION = "Type the org slug to confirm: ";

const readerExact: PromptReader = async () => "vercel";
const readerWithNewline: PromptReader = async () => "vercel\n";
const readerMismatch: PromptReader = async () => "wrong-slug";
const readerNull: PromptReader = async () => null;
const readerEmpty: PromptReader = async () => "";

describe("promptConfirm", () => {
  it("returns true when the typed slug matches the expected value", async () => {
    expect(await promptConfirm(QUESTION, "vercel", readerExact)).toBe(true);
  });

  it("trims trailing whitespace before comparing (newline tolerated)", async () => {
    expect(await promptConfirm(QUESTION, "vercel", readerWithNewline)).toBe(true);
  });

  it("returns false when the typed slug does not match", async () => {
    expect(await promptConfirm(QUESTION, "vercel", readerMismatch)).toBe(false);
  });

  it("returns false when the reader returns null (no TTY available)", async () => {
    expect(await promptConfirm(QUESTION, "vercel", readerNull)).toBe(false);
  });

  it("treats an empty answer as a mismatch", async () => {
    expect(await promptConfirm(QUESTION, "vercel", readerEmpty)).toBe(false);
  });
});
