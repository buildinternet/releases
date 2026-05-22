import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { legacyEnv, __resetLegacyEnvWarnings } from "@releases/lib/legacy-env";

describe("legacyEnv", () => {
  beforeEach(() => {
    delete process.env.RELEASES_FOO;
    delete process.env.RELEASED_FOO;
    __resetLegacyEnvWarnings();
  });
  afterEach(() => {
    delete process.env.RELEASES_FOO;
    delete process.env.RELEASED_FOO;
  });

  test("prefers the canonical var", () => {
    process.env.RELEASES_FOO = "new";
    process.env.RELEASED_FOO = "old";
    expect(legacyEnv("RELEASES_FOO", "RELEASED_FOO")).toBe("new");
  });

  test("falls back to the legacy var", () => {
    process.env.RELEASED_FOO = "old";
    expect(legacyEnv("RELEASES_FOO", "RELEASED_FOO")).toBe("old");
  });

  test("returns undefined when neither is set", () => {
    expect(legacyEnv("RELEASES_FOO", "RELEASED_FOO")).toBeUndefined();
  });

  test("treats empty string as unset", () => {
    process.env.RELEASES_FOO = "";
    process.env.RELEASED_FOO = "old";
    expect(legacyEnv("RELEASES_FOO", "RELEASED_FOO")).toBe("old");
  });

  test("warns at most once per legacy name", () => {
    const calls: string[] = [];
    process.env.RELEASED_FOO = "old";
    legacyEnv("RELEASES_FOO", "RELEASED_FOO", (m) => calls.push(m));
    legacyEnv("RELEASES_FOO", "RELEASED_FOO", (m) => calls.push(m));
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("RELEASED_FOO");
    expect(calls[0]).toContain("RELEASES_FOO");
  });
});
