import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import {
  stagingAccessGate,
  isStagingGateExemptPath,
  STAGING_KEY_HEADER,
} from "../src/middleware/staging-access";

/**
 * The staging access gate (#444 holdover) blocks every request to the staging
 * hostname unless it carries the shared key — except the JWKS path, which must
 * stay public so a resource server's server-to-server OAuth JWT verification
 * (#1483) can fetch the keys (its outbound fetch can't carry the staging key).
 */

const SECRET = "topsecret-staging-key";

/** A fresh secret binding per test — getSecret memoizes by binding identity. */
function keyBinding(value: string = SECRET) {
  return { get: async () => value };
}

/** Build a tiny app guarded by the gate that 200s every otherwise-allowed path. */
function gatedApp(env: { STAGING_ACCESS_KEY?: { get(): Promise<string> } }) {
  const app = new Hono<{ Bindings: typeof env }>();
  app.use("*", stagingAccessGate());
  app.all("*", (c) => c.text("ok"));
  return (path: string, headers: Record<string, string> = {}) =>
    app.request(`https://api-staging.releases.sh${path}`, { headers }, env);
}

describe("isStagingGateExemptPath", () => {
  it("exempts the JWKS path", () => {
    expect(isStagingGateExemptPath("/api/auth/jwks")).toBe(true);
  });

  it("does not exempt other auth/discovery paths", () => {
    expect(isStagingGateExemptPath("/api/auth/oauth2/token")).toBe(false);
    expect(isStagingGateExemptPath("/.well-known/oauth-protected-resource")).toBe(false);
    expect(isStagingGateExemptPath("/v1/orgs")).toBe(false);
  });
});

describe("stagingAccessGate", () => {
  it("passes everything through when STAGING_ACCESS_KEY is unbound (prod/local)", async () => {
    const req = gatedApp({});
    expect((await req("/v1/orgs")).status).toBe(200);
    expect((await req("/api/auth/jwks")).status).toBe(200);
  });

  it("401s a non-exempt path without the key when the gate is bound", async () => {
    const res = await gatedApp({ STAGING_ACCESS_KEY: keyBinding() })("/v1/orgs");
    expect(res.status).toBe(401);
  });

  it("passes a non-exempt path with the correct key", async () => {
    const res = await gatedApp({ STAGING_ACCESS_KEY: keyBinding() })("/v1/orgs", {
      [STAGING_KEY_HEADER]: SECRET,
    });
    expect(res.status).toBe(200);
  });

  it("lets the JWKS path through WITHOUT the key even when the gate is bound", async () => {
    const res = await gatedApp({ STAGING_ACCESS_KEY: keyBinding() })("/api/auth/jwks");
    expect(res.status).toBe(200);
  });

  it("lets the JWKS path through even with a WRONG key (it never checks)", async () => {
    const res = await gatedApp({ STAGING_ACCESS_KEY: keyBinding() })("/api/auth/jwks", {
      [STAGING_KEY_HEADER]: "wrong",
    });
    expect(res.status).toBe(200);
  });
});
