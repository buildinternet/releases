import { describe, expect, it } from "bun:test";
import {
  CF_ACCOUNT_ID,
  checkAgainstRaw,
  IMAGE_REPO,
  INPUT_PATHS,
  REGISTRY_PREFIX,
} from "../../scripts/discovery-container-image.ts";

describe("discovery-container-image", () => {
  it("pins the registry prefix to the shared Build Internet account + repo", () => {
    expect(CF_ACCOUNT_ID).toBe("b082600d280d44fd5da3501bc1bffe2f");
    expect(IMAGE_REPO).toBe("releases-discovery-sandbox");
    expect(REGISTRY_PREFIX).toBe(
      "registry.cloudflare.com/b082600d280d44fd5da3501bc1bffe2f/releases-discovery-sandbox",
    );
  });

  it("hashes only the Dockerfile's real inputs — the Dockerfile and the skills it COPYs", () => {
    expect(INPUT_PATHS).toEqual(["workers/discovery/Dockerfile", ".claude/skills"]);
  });

  describe("checkAgainstRaw", () => {
    const tag = "abc123def456";
    const good = (t: string) =>
      [`"image": "${REGISTRY_PREFIX}:${t}",`, `"image": "${REGISTRY_PREFIX}:${t}",`].join("\n");

    it("passes when both image fields pin the expected tag", () => {
      const result = checkAgainstRaw(good(tag), tag);
      expect(result.ok).toBe(true);
    });

    it("fails when a field is stale", () => {
      const raw = [
        `"image": "${REGISTRY_PREFIX}:${tag}",`,
        `"image": "${REGISTRY_PREFIX}:deadbeef1234",`,
      ].join("\n");
      const result = checkAgainstRaw(raw, tag);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/stale/);
    });

    it("fails when only one field is pinned (e.g. still ./Dockerfile)", () => {
      const raw = [`"image": "${REGISTRY_PREFIX}:${tag}",`, `"image": "./Dockerfile",`].join("\n");
      const result = checkAgainstRaw(raw, tag);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/expected 2/);
    });

    it("fails when neither field is pinned", () => {
      const raw = [`"image": "./Dockerfile",`, `"image": "./Dockerfile",`].join("\n");
      const result = checkAgainstRaw(raw, tag);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/found 0/);
    });

    it("does not match a same-length hex tag from a different repo", () => {
      const raw = [
        `"image": "${REGISTRY_PREFIX}:${tag}",`,
        `"image": "registry.cloudflare.com/${CF_ACCOUNT_ID}/some-other-repo:${tag}",`,
      ].join("\n");
      const result = checkAgainstRaw(raw, tag);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/found 1/);
    });
  });
});
