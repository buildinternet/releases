import { describe, expect, it } from "bun:test";
import {
  buildKeepSet,
  deployedVersionIds,
  digestFromImageRef,
  extractPinnedTags,
  findRepoEntry,
  keepTagsForEnv,
  parseArgs,
  planPrune,
  resolveTagsFromGitHistory,
  tagForVersionId,
} from "../../scripts/prune-container-images.ts";
import { REGISTRY_PREFIX } from "../../scripts/discovery-container-image.ts";

const deploy = (id: string, pct = 100) => ({ versions: [{ version_id: id, percentage: pct }] });

describe("prune-container-images", () => {
  it("derives the image tag from the first 8 hex chars of the version id", () => {
    expect(tagForVersionId("0acb1dc7-1111-4222-8333-444455556666")).toBe("0acb1dc7");
  });

  it("orders deployed version ids newest first and skips zero-percentage versions", () => {
    const ids = deployedVersionIds([
      deploy("aaaa"),
      deploy("bbbb", 0),
      deploy("cccc"),
      deploy("cccc"),
    ]);
    expect(ids).toEqual(["cccc", "aaaa"]);
  });

  it("keeps the current tag plus the previous N", () => {
    const ids = ["0acb1dc7-x", "f59c1f51-x", "02a42c0a-x", "db24b381-x"];
    expect(keepTagsForEnv(ids, 2)).toEqual({
      current: "0acb1dc7",
      tags: ["0acb1dc7", "f59c1f51", "02a42c0a"],
    });
    expect(keepTagsForEnv([], 5)).toEqual({ current: null, tags: [] });
  });

  it("plans deletes for everything outside the keep set", () => {
    const keep = buildKeepSet([["aaaa1111", "bbbb2222"], ["cccc3333"]]);
    const plan = planPrune(["dddd4444", "aaaa1111", "cccc3333"], keep);
    expect(plan.map((p) => `${p.tag}:${p.action}`)).toEqual([
      "aaaa1111:keep",
      "cccc3333:keep",
      "dddd4444:delete",
    ]);
  });

  it("returns null when the repo is absent from the listing (never 'zero images')", () => {
    const listing = [{ name: "releases-discovery-sandbox", tags: ["a", "a", "b"] }];
    expect(findRepoEntry(listing, "releases-discovery-sandbox")).toEqual({ tags: ["a", "b"] });
    expect(findRepoEntry(listing, "releases-discovery-staging-sandbox-staging")).toBeNull();
    expect(findRepoEntry("garbage", "releases-discovery-sandbox")).toBeNull();
  });

  it("extracts a digest from an @sha256 image reference only", () => {
    const d = "sha256:" + "f".repeat(64);
    expect(digestFromImageRef(`registry.cloudflare.com/acct/releases-discovery-sandbox@${d}`)).toBe(
      d,
    );
    expect(
      digestFromImageRef("registry.cloudflare.com/acct/released-discovery-sandbox:b6bd9f6b"),
    ).toBeNull();
    expect(digestFromImageRef(undefined)).toBeNull();
  });

  it("extracts pinned content-hash tags from wrangler.jsonc text", () => {
    const raw = [
      `"image": "${REGISTRY_PREFIX}:abc123def456",`,
      `"image": "${REGISTRY_PREFIX}:abc123def456",`,
    ].join("\n");
    expect(extractPinnedTags(raw, REGISTRY_PREFIX)).toEqual(new Set(["abc123def456"]));
    expect(extractPinnedTags(`"image": "./Dockerfile"`, REGISTRY_PREFIX)).toEqual(new Set());
  });

  it("resolves content-hash keep tags from wrangler.jsonc history on origin/main", () => {
    const shas = ["sha1", "sha2", "sha3"];
    const contentAt: Record<string, string> = {
      sha1: `"image": "${REGISTRY_PREFIX}:aaaa11112222"`,
      sha2: `"image": "${REGISTRY_PREFIX}:bbbb33334444"`,
      // sha3 pre-dates the pin (still ./Dockerfile) — contributes no tags.
      sha3: `"image": "./Dockerfile"`,
    };
    const tags = resolveTagsFromGitHistory({
      n: 3,
      repoPrefix: REGISTRY_PREFIX,
      path: "workers/discovery/wrangler.jsonc",
      gitLog: () => shas,
      gitShowAt: (sha) => contentAt[sha]!,
    });
    expect(tags).toEqual(new Set(["aaaa11112222", "bbbb33334444"]));
  });

  it("skips a commit gitShowAt fails to read instead of throwing", () => {
    const tags = resolveTagsFromGitHistory({
      n: 2,
      repoPrefix: REGISTRY_PREFIX,
      path: "workers/discovery/wrangler.jsonc",
      gitLog: () => ["a", "b"],
      gitShowAt: (sha) => {
        if (sha === "a") throw new Error("no such path at this revision");
        return `"image": "${REGISTRY_PREFIX}:cccc55556666"`;
      },
    });
    expect(tags).toEqual(new Set(["cccc55556666"]));
  });

  it("parses flags with a dry-run default", () => {
    expect(parseArgs([])).toEqual({ keep: 5, yes: false });
    expect(parseArgs(["--keep", "3", "--yes"])).toEqual({ keep: 3, yes: true });
    expect(() => parseArgs(["--keep", "-1"])).toThrow();
    expect(() => parseArgs(["--nope"])).toThrow();
  });
});
