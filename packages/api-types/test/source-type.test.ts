import { describe, it, expect } from "bun:test";
import { SOURCE_TYPES } from "@buildinternet/releases-core/source-enums";
import { SourceTypeSchema } from "../src/schemas/sources.js";

describe("appstore source type", () => {
  it("is a member of SOURCE_TYPES", () => {
    expect(SOURCE_TYPES).toContain("appstore");
  });

  it("is accepted by SourceTypeSchema", () => {
    expect(SourceTypeSchema.parse("appstore")).toBe("appstore");
  });
});
