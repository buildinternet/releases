import { describe, it, expect } from "bun:test";
import { newSourceId, newReleaseId, newOrgId, newProductId, newTagId } from "@buildinternet/releases-core/id";

describe("ID generators", () => {
  it("newSourceId has correct prefix", () => {
    expect(newSourceId()).toMatch(/^src_/);
  });

  it("newReleaseId has correct prefix", () => {
    expect(newReleaseId()).toMatch(/^rel_/);
  });

  it("newOrgId has correct prefix", () => {
    expect(newOrgId()).toMatch(/^org_/);
  });

  it("newProductId has correct prefix", () => {
    expect(newProductId()).toMatch(/^prod_/);
  });

  it("newTagId has correct prefix", () => {
    expect(newTagId()).toMatch(/^tag_/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newSourceId()));
    expect(ids.size).toBe(100);
  });
});
