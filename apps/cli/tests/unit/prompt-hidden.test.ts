import { describe, it, expect } from "bun:test";
import { hiddenPromptReader } from "../../src/lib/prompt-hidden.js";

describe("hiddenPromptReader", () => {
  it("returns null when stdin is not a TTY", async () => {
    // In the test runner stdin is not a TTY.
    expect(await hiddenPromptReader("token: ")).toBeNull();
  });
});
