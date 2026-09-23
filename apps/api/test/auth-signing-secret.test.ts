import { describe, it, expect } from "bun:test";
import { resolveSigningSecret } from "../src/auth/index.js";

/**
 * Local-dev signing-secret fallback (#1425). In deployed envs BETTER_AUTH_SECRET
 * is a Secrets Store binding; in local `wrangler dev` that binding can't resolve
 * and a same-named .dev.vars plain string doesn't override it, so the worker fell
 * back to an ephemeral per-restart secret. `resolveSigningSecret` prefers the
 * binding but falls through to the distinct plain-string BETTER_AUTH_SECRET_DEV
 * when the binding yields no usable value.
 */

/** A Secrets Store binding stub whose .get() resolves to `value`. */
const binding = (value: string | null) => ({ get: async () => value });
/** A binding that is present but unresolvable (the local `wrangler dev` case). */
const throwingBinding = () => ({
  get: async () => {
    throw new Error("Secrets Store unreachable in local dev");
  },
});

describe("resolveSigningSecret", () => {
  it("returns the Secrets Store binding value when it resolves (prod path)", async () => {
    expect(
      await resolveSigningSecret({
        BETTER_AUTH_SECRET: binding("prod-secret"),
        BETTER_AUTH_SECRET_DEV: "dev-secret",
      }),
    ).toBe("prod-secret");
  });

  it("returns a plain-string BETTER_AUTH_SECRET directly", async () => {
    expect(await resolveSigningSecret({ BETTER_AUTH_SECRET: "plain-secret" })).toBe("plain-secret");
  });

  it("falls back to BETTER_AUTH_SECRET_DEV when the binding is unresolvable (local dev)", async () => {
    expect(
      await resolveSigningSecret({
        BETTER_AUTH_SECRET: throwingBinding(),
        BETTER_AUTH_SECRET_DEV: "dev-secret",
      }),
    ).toBe("dev-secret");
  });

  it("falls back to BETTER_AUTH_SECRET_DEV when the binding resolves to null", async () => {
    expect(
      await resolveSigningSecret({
        BETTER_AUTH_SECRET: binding(null),
        BETTER_AUTH_SECRET_DEV: "dev-secret",
      }),
    ).toBe("dev-secret");
  });

  it("falls back to BETTER_AUTH_SECRET_DEV when the binding resolves to empty string", async () => {
    expect(
      await resolveSigningSecret({
        BETTER_AUTH_SECRET: binding(""),
        BETTER_AUTH_SECRET_DEV: "dev-secret",
      }),
    ).toBe("dev-secret");
  });

  it("uses BETTER_AUTH_SECRET_DEV when no binding is set at all", async () => {
    expect(await resolveSigningSecret({ BETTER_AUTH_SECRET_DEV: "dev-secret" })).toBe("dev-secret");
  });

  it("returns null when neither the binding nor the dev fallback is set", async () => {
    expect(await resolveSigningSecret({})).toBeNull();
  });

  it("returns null when the binding is unresolvable and there is no dev fallback", async () => {
    expect(await resolveSigningSecret({ BETTER_AUTH_SECRET: throwingBinding() })).toBeNull();
  });

  it("treats an empty dev fallback as absent (null, not empty string)", async () => {
    expect(
      await resolveSigningSecret({ BETTER_AUTH_SECRET: binding(null), BETTER_AUTH_SECRET_DEV: "" }),
    ).toBeNull();
  });

  it("prefers a working binding over the dev fallback (prod safety)", async () => {
    // Guards the invariant that a stray BETTER_AUTH_SECRET_DEV can never override a
    // resolving prod binding — the dev var only wins when the binding has no value.
    expect(
      await resolveSigningSecret({
        BETTER_AUTH_SECRET: binding("the-real-prod-secret"),
        BETTER_AUTH_SECRET_DEV: "laptop-secret",
      }),
    ).toBe("the-real-prod-secret");
  });
});
