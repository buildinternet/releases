import { describe, it, expect } from "bun:test";
import { partitionAccounts } from "../../src/cli/commands/import.js";

// #283: import must dedup org accounts on (platform, handle), not platform
// alone — org_accounts is one-to-many (the server unique index is on the pair),
// so an org can hold a second handle on a platform it's already linked to.
describe("partitionAccounts (#283)", () => {
  it("links a new handle on an already-linked platform", () => {
    const existing = [{ platform: "x", handle: "Cloudflare" }];
    const desired = [{ platform: "x", handle: "cfchangelog" }];
    const { toLink, alreadyLinked } = partitionAccounts(existing, desired);
    expect(toLink).toEqual([{ platform: "x", handle: "cfchangelog" }]);
    expect(alreadyLinked).toEqual([]);
  });

  it("reports an exact (platform, handle) pair as already linked", () => {
    const existing = [{ platform: "x", handle: "Cloudflare" }];
    const desired = [{ platform: "x", handle: "Cloudflare" }];
    const { toLink, alreadyLinked } = partitionAccounts(existing, desired);
    expect(toLink).toEqual([]);
    expect(alreadyLinked).toEqual([{ platform: "x", handle: "Cloudflare" }]);
  });

  it("handle match is case-sensitive (mirrors the server unique index)", () => {
    const existing = [{ platform: "x", handle: "Cloudflare" }];
    const desired = [{ platform: "x", handle: "cloudflare" }];
    const { toLink } = partitionAccounts(existing, desired);
    expect(toLink).toEqual([{ platform: "x", handle: "cloudflare" }]);
  });

  it("dedups a pair listed twice in the same manifest", () => {
    const existing: Array<{ platform: string; handle: string }> = [];
    const desired = [
      { platform: "x", handle: "acme" },
      { platform: "x", handle: "acme" },
    ];
    const { toLink, alreadyLinked } = partitionAccounts(existing, desired);
    expect(toLink).toEqual([{ platform: "x", handle: "acme" }]);
    expect(alreadyLinked).toEqual([{ platform: "x", handle: "acme" }]);
  });

  it("links every account when the org has none", () => {
    const desired = [
      { platform: "x", handle: "acme" },
      { platform: "github", handle: "acme" },
    ];
    const { toLink, alreadyLinked } = partitionAccounts([], desired);
    expect(toLink).toEqual(desired);
    expect(alreadyLinked).toEqual([]);
  });
});
