import { describe, expect, it } from "bun:test";
import { foldUserFollowRows, releaseMatchesFollows } from "./follows-match.js";

describe("releaseMatchesFollows", () => {
  it("matches an org follow", () => {
    expect(
      releaseMatchesFollows(
        { orgId: "org_a", productId: "prd_x" },
        { orgIds: new Set(["org_a"]), productIds: new Set() },
      ),
    ).toBe(true);
  });

  it("matches a product follow when org is not followed", () => {
    expect(
      releaseMatchesFollows(
        { orgId: "org_a", productId: "prd_x" },
        { orgIds: new Set(), productIds: new Set(["prd_x"]) },
      ),
    ).toBe(true);
  });

  it("does not match unrelated org/product", () => {
    expect(
      releaseMatchesFollows(
        { orgId: "org_a", productId: "prd_x" },
        { orgIds: new Set(["org_b"]), productIds: new Set(["prd_y"]) },
      ),
    ).toBe(false);
  });
});

describe("foldUserFollowRows", () => {
  it("groups rows per user", () => {
    const map = foldUserFollowRows([
      { userId: "u1", targetType: "org", targetId: "org_a" },
      { userId: "u1", targetType: "product", targetId: "prd_x" },
      { userId: "u2", targetType: "org", targetId: "org_b" },
    ]);
    expect(map.get("u1")?.orgIds.has("org_a")).toBe(true);
    expect(map.get("u1")?.productIds.has("prd_x")).toBe(true);
    expect(map.get("u2")?.orgIds.has("org_b")).toBe(true);
  });
});
