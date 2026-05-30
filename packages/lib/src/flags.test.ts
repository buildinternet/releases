import { describe, expect, it } from "bun:test";
import { FLAGS, flag, type FlagshipBinding } from "./flags.js";

/** Stub binding that always returns `value`, ignoring the default. */
function bindingReturning(value: boolean): FlagshipBinding {
  return { getBooleanValue: async () => value };
}

/** Stub binding that throws on eval. */
const throwingBinding: FlagshipBinding = {
  getBooleanValue: async () => {
    throw new Error("flagship down");
  },
};

describe("flag()", () => {
  it("returns the Flagship value when the binding yields one", async () => {
    // Flagship says true even though the var is unset and default is false.
    expect(await flag(bindingReturning(true), undefined, FLAGS.pollFetchUseWorkflow)).toBe(true);
    expect(await flag(bindingReturning(false), "true", FLAGS.pollFetchUseWorkflow)).toBe(false);
  });

  it("falls back to the var value when the binding is absent", async () => {
    expect(await flag(undefined, "true", FLAGS.pollFetchUseWorkflow)).toBe(true);
    expect(await flag(undefined, "false", FLAGS.pollFetchUseWorkflow)).toBe(false);
  });

  it("falls back to the hardcoded default when both binding and var are absent", async () => {
    expect(await flag(undefined, undefined, FLAGS.pollFetchUseWorkflow)).toBe(false);
  });

  it("collapses an eval error to the var/default fallback", async () => {
    expect(await flag(throwingBinding, "true", FLAGS.pollFetchUseWorkflow)).toBe(true);
    expect(await flag(throwingBinding, undefined, FLAGS.pollFetchUseWorkflow)).toBe(false);
  });

  it('treats any non-"true" string as false (var semantics)', async () => {
    expect(await flag(undefined, "1", FLAGS.pollFetchUseWorkflow)).toBe(false);
    expect(await flag(undefined, "", FLAGS.pollFetchUseWorkflow)).toBe(false);
  });
});

describe("FLAGS registry", () => {
  const defs = Object.values(FLAGS);

  it("has unique, kebab-case keys", () => {
    const keys = defs.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("has unique env names in SCREAMING_SNAKE_CASE", () => {
    const envs = defs.map((d) => d.env);
    expect(new Set(envs).size).toBe(envs.length);
    for (const e of envs) expect(e).toMatch(/^[A-Z0-9]+(_[A-Z0-9]+)*$/);
  });
});
