import { describe, it, expect } from "bun:test";
import { isAppStoreFetched } from "@releases/adapters/source-meta";
import type { Source } from "@buildinternet/releases-core/schema";

function srcOfType(type: string): Source {
  return { type } as unknown as Source;
}

describe("isAppStoreFetched", () => {
  it("is true for type=appstore", () => {
    expect(isAppStoreFetched(srcOfType("appstore"))).toBe(true);
  });
  it("is false for other types", () => {
    expect(isAppStoreFetched(srcOfType("feed"))).toBe(false);
    expect(isAppStoreFetched(srcOfType("github"))).toBe(false);
  });
});
