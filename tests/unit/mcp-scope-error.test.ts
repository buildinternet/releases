import { describe, it, expect } from "bun:test";
import { scopeErrorText } from "../../workers/mcp/src/scope-error.js";

describe("scopeErrorText", () => {
  it("names both the relk_ machine lane and the relu_ user lane", () => {
    const msg = scopeErrorText("write");
    expect(msg).toContain("insufficient_scope");
    expect(msg).toContain("write");
    expect(msg).toContain("relk_");
    expect(msg).toContain("relu_");
  });
});
