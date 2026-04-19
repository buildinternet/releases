import { describe, it, expect } from "bun:test";
import { newSourceId, newReleaseId, newOrgId, newProductId, newTagId } from "@releases/core-internal/id";
import { newCronRunId } from "@releases/core-internal/id";

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

  it("newCronRunId has correct prefix", () => {
    expect(newCronRunId()).toMatch(/^crun_/);
  });

  it("newCronRunId generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newCronRunId()));
    expect(ids.size).toBe(100);
  });
});
