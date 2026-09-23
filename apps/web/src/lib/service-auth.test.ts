import { describe, expect, it } from "bun:test";
import { verifyServiceKey } from "./service-auth.js";

const KEY = "shared-service-key";

function req(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://releases.sh/api/whatever", { method: "POST", headers });
}

describe("verifyServiceKey", () => {
  it("accepts a matching bearer token", () => {
    expect(verifyServiceKey(req(KEY), KEY)).toEqual({ ok: true });
  });

  it("fails closed when no key is configured, rather than allowing the call", () => {
    expect(verifyServiceKey(req(KEY), undefined)).toEqual({ ok: false, reason: "not_configured" });
  });

  it("rejects a missing Authorization header", () => {
    expect(verifyServiceKey(req(null), KEY)).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("rejects a mismatched token", () => {
    expect(verifyServiceKey(req("nope"), KEY)).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("rejects a non-Bearer scheme", () => {
    const r = new Request("https://releases.sh/api/whatever", {
      method: "POST",
      headers: { authorization: `Basic ${KEY}` },
    });
    expect(verifyServiceKey(r, KEY)).toEqual({ ok: false, reason: "unauthorized" });
  });

  // A token that merely shares a prefix must not pass; length is checked before
  // the comparison so the compare stays constant-time over equal-length inputs.
  it("rejects a token that is a prefix of the key", () => {
    expect(verifyServiceKey(req(KEY.slice(0, 5)), KEY)).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });
});
