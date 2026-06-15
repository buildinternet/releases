import { describe, expect, it } from "bun:test";
import { FLAGS, flag, flagState, type FlagshipBinding } from "./flags.js";

interface RecordingBinding extends FlagshipBinding {
  lastCall?: { key: string; defaultValue: boolean };
}

/** Stub binding that records its last call and always returns `value`. */
function bindingReturning(value: boolean): RecordingBinding {
  const binding: RecordingBinding = {
    getBooleanValue: async (key, defaultValue) => {
      binding.lastCall = { key, defaultValue };
      return value;
    },
  };
  return binding;
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
    expect(await flag(bindingReturning(true), undefined, FLAGS.cacheDisabled)).toBe(true);
    expect(await flag(bindingReturning(false), "true", FLAGS.cacheDisabled)).toBe(false);
  });

  it("consults Flagship with the flag key and the computed fallback as defaultValue", async () => {
    const stub = bindingReturning(false);
    await flag(stub, "true", FLAGS.cacheDisabled);
    expect(stub.lastCall).toEqual({ key: "cache-disabled", defaultValue: true });

    // Var unset → the hardcoded default flows through as the defaultValue.
    const stub2 = bindingReturning(false);
    await flag(stub2, undefined, FLAGS.cacheDisabled);
    expect(stub2.lastCall).toEqual({ key: "cache-disabled", defaultValue: false });
  });

  it("falls back to the var value when the binding is absent", async () => {
    expect(await flag(undefined, "true", FLAGS.cacheDisabled)).toBe(true);
    expect(await flag(undefined, "false", FLAGS.cacheDisabled)).toBe(false);
  });

  it("falls back to the hardcoded default when both binding and var are absent", async () => {
    expect(await flag(undefined, undefined, FLAGS.cacheDisabled)).toBe(false);
  });

  it("collapses an eval error to the var/default fallback", async () => {
    expect(await flag(throwingBinding, "true", FLAGS.cacheDisabled)).toBe(true);
    expect(await flag(throwingBinding, undefined, FLAGS.cacheDisabled)).toBe(false);
  });

  it('treats any non-"true" string as false (var semantics)', async () => {
    expect(await flag(undefined, "1", FLAGS.cacheDisabled)).toBe(false);
    expect(await flag(undefined, "", FLAGS.cacheDisabled)).toBe(false);
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

/** Stub binding that echoes the passed default — simulates an ABSENT Flagship key. */
const echoingBinding: FlagshipBinding = {
  getBooleanValue: async (_key, defaultValue) => defaultValue,
};

describe("flagState()", () => {
  it("reads on/off from the var when the binding is absent", async () => {
    expect(await flagState(undefined, "true", FLAGS.cacheDisabled)).toBe("on");
    expect(await flagState(undefined, "false", FLAGS.cacheDisabled)).toBe("off");
  });

  it("returns unset when neither binding nor var supplies a value", async () => {
    expect(await flagState(undefined, undefined, FLAGS.cacheDisabled)).toBe("unset");
  });

  it("reads an explicit Flagship value (present key wins over the probe defaults)", async () => {
    expect(await flagState(bindingReturning(true), undefined, FLAGS.cacheDisabled)).toBe("on");
    expect(await flagState(bindingReturning(false), undefined, FLAGS.cacheDisabled)).toBe("off");
  });

  it("returns unset when the Flagship key is absent (probe defaults differ)", async () => {
    expect(await flagState(echoingBinding, undefined, FLAGS.cacheDisabled)).toBe("unset");
  });

  it("falls back to the var when the Flagship key is absent", async () => {
    expect(await flagState(echoingBinding, "true", FLAGS.cacheDisabled)).toBe("on");
    expect(await flagState(echoingBinding, "false", FLAGS.cacheDisabled)).toBe("off");
  });

  it("lets Flagship win over the var when the key is present", async () => {
    expect(await flagState(bindingReturning(true), "false", FLAGS.cacheDisabled)).toBe("on");
  });

  it("collapses an eval error to the var, else unset", async () => {
    expect(await flagState(throwingBinding, "true", FLAGS.cacheDisabled)).toBe("on");
    expect(await flagState(throwingBinding, undefined, FLAGS.cacheDisabled)).toBe("unset");
  });
});

describe("openrouterEnabled flag", () => {
  it("is registered with the expected key/env and defaults ON (OpenRouter is the prod default)", () => {
    expect(FLAGS.openrouterEnabled).toEqual({
      key: "openrouter-enabled",
      env: "OPENROUTER_ENABLED",
      default: true,
    });
  });
});
