import { describe, it, expect } from "bun:test";
import {
  parseCache,
  isOutdated,
  isCheckSuppressed,
  buildNagMessage,
  getLockSuppressionState,
  type SkillsCache,
} from "../../src/lib/skills-update-check.js";

describe("parseCache", () => {
  it("parses a well-formed cache", () => {
    const raw = JSON.stringify({ baseline: "abc", latest: "abc", checkedAt: 123 });
    expect(parseCache(raw)).toEqual({ baseline: "abc", latest: "abc", checkedAt: 123 });
  });

  it("coerces missing baseline/latest to null while preserving checkedAt", () => {
    const raw = JSON.stringify({ checkedAt: 500 });
    expect(parseCache(raw)).toEqual({ baseline: null, latest: null, checkedAt: 500 });
  });

  it("returns null when checkedAt is missing or non-numeric", () => {
    expect(parseCache(JSON.stringify({ baseline: "abc" }))).toBeNull();
    expect(parseCache(JSON.stringify({ baseline: "abc", checkedAt: "now" }))).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(parseCache("not json")).toBeNull();
    expect(parseCache("")).toBeNull();
  });

  it("ignores non-string baseline/latest", () => {
    const raw = JSON.stringify({ baseline: 42, latest: true, checkedAt: 1 });
    expect(parseCache(raw)).toEqual({ baseline: null, latest: null, checkedAt: 1 });
  });
});

describe("isOutdated", () => {
  it("returns true when baseline differs from latest", () => {
    expect(isOutdated("abc", "def")).toBe(true);
  });

  it("returns false when baseline equals latest", () => {
    expect(isOutdated("abc", "abc")).toBe(false);
  });

  it("returns false when either side is null (incomplete signal)", () => {
    expect(isOutdated(null, "abc")).toBe(false);
    expect(isOutdated("abc", null)).toBe(false);
    expect(isOutdated(null, null)).toBe(false);
  });
});

describe("isCheckSuppressed", () => {
  it("returns true when RELEASES_DISABLE_SKILL_UPDATE_CHECK=1", () => {
    expect(isCheckSuppressed({ RELEASES_DISABLE_SKILL_UPDATE_CHECK: "1" })).toBe(true);
  });

  it("returns true for the string 'true'", () => {
    expect(isCheckSuppressed({ RELEASES_DISABLE_SKILL_UPDATE_CHECK: "true" })).toBe(true);
  });

  it("returns false for other truthy strings (only '1' and 'true' opt out)", () => {
    expect(isCheckSuppressed({ RELEASES_DISABLE_SKILL_UPDATE_CHECK: "yes" })).toBe(false);
    expect(isCheckSuppressed({ RELEASES_DISABLE_SKILL_UPDATE_CHECK: "0" })).toBe(false);
    expect(isCheckSuppressed({ RELEASES_DISABLE_SKILL_UPDATE_CHECK: "" })).toBe(false);
  });

  it("returns false when the env var is unset", () => {
    expect(isCheckSuppressed({})).toBe(false);
  });
});

describe("buildNagMessage", () => {
  it("references the install command so the user knows how to refresh", () => {
    const msg = buildNagMessage();
    expect(msg).toContain("releases skills install");
  });

  it("uses ANSI dim styling for consistency with the CLI update nag", () => {
    const msg = buildNagMessage();
    expect(msg.startsWith("\x1b[2m")).toBe(true);
    expect(msg.endsWith("\x1b[0m")).toBe(true);
  });
});

describe("SkillsCache shape", () => {
  it("typechecks the documented fields", () => {
    const cache: SkillsCache = { baseline: "abc", latest: "def", checkedAt: 1 };
    expect(cache.baseline).toBe("abc");
  });
});

describe("getLockSuppressionState", () => {
  it("proceeds when the lock file is missing", () => {
    expect(getLockSuppressionState(null)).toBe("proceed");
  });

  it("proceeds when the lock file is invalid JSON", () => {
    expect(getLockSuppressionState("not json")).toBe("proceed");
    expect(getLockSuppressionState("")).toBe("proceed");
  });

  it("proceeds when the lock file lacks a `skills` map (older / wrong schema)", () => {
    expect(getLockSuppressionState(JSON.stringify({ version: 3 }))).toBe("proceed");
    expect(getLockSuppressionState(JSON.stringify({ skills: "not an object" }))).toBe("proceed");
  });

  it("proceeds when at least one entry sources from buildinternet/releases", () => {
    const lock = JSON.stringify({
      version: 3,
      skills: {
        "releases-cli": { source: "buildinternet/releases", skillFolderHash: "abc" },
        "ai-sdk": { source: "vercel/ai", skillFolderHash: "def" },
      },
    });
    expect(getLockSuppressionState(lock)).toBe("proceed");
  });

  it("still proceeds for legacy installs sourced from buildinternet/releases-cli", () => {
    const lock = JSON.stringify({
      version: 3,
      skills: {
        "releases-cli": { source: "buildinternet/releases-cli", skillFolderHash: "abc" },
      },
    });
    expect(getLockSuppressionState(lock)).toBe("proceed");
  });

  it("suppresses when the lock file has skills but no releases-cli entries", () => {
    // User installed other skills via `skills` but uninstalled / never installed ours.
    const lock = JSON.stringify({
      version: 3,
      skills: {
        "ai-sdk": { source: "vercel/ai", skillFolderHash: "def" },
        turborepo: { source: "vercel/turborepo", skillFolderHash: "ghi" },
      },
    });
    expect(getLockSuppressionState(lock)).toBe("suppress");
  });

  it("suppresses when the lock file has an empty skills map", () => {
    expect(getLockSuppressionState(JSON.stringify({ version: 3, skills: {} }))).toBe("suppress");
  });

  it("ignores entries with non-string sources rather than treating them as a match", () => {
    const lock = JSON.stringify({
      version: 3,
      skills: { broken: { source: 42, skillFolderHash: "abc" } },
    });
    expect(getLockSuppressionState(lock)).toBe("suppress");
  });
});
