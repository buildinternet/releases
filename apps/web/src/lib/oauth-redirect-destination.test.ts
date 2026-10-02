import { describe, expect, it } from "bun:test";
import { consentTrust, describeRedirectDestination } from "./oauth-redirect-destination";

describe("describeRedirectDestination", () => {
  it("names the host of a web redirect", () => {
    expect(describeRedirectDestination("https://attacker.example.com/cb?x=1")).toEqual({
      kind: "web",
      host: "attacker.example.com",
    });
    expect(describeRedirectDestination("https://claude.ai:8443/api/mcp/auth_callback")).toEqual({
      kind: "web",
      host: "claude.ai:8443",
    });
  });

  it("treats loopback redirects as local", () => {
    for (const uri of [
      "http://127.0.0.1:33418/callback",
      "http://localhost:6274/oauth/callback",
      "http://[::1]:8080/cb",
    ]) {
      expect(describeRedirectDestination(uri)).toEqual({ kind: "local" });
    }
  });

  it("treats private-use schemes as an app", () => {
    expect(describeRedirectDestination("cursor://anysphere.cursor-mcp/oauth/callback")).toEqual({
      kind: "app",
      scheme: "cursor",
    });
    expect(describeRedirectDestination("com.example.app:/cb")).toEqual({
      kind: "app",
      scheme: "com.example.app",
    });
  });

  it("returns null for missing or malformed input", () => {
    expect(describeRedirectDestination(null)).toBeNull();
    expect(describeRedirectDestination("")).toBeNull();
    expect(describeRedirectDestination("not a url")).toBeNull();
  });

  it("does not treat a lookalike host as loopback", () => {
    expect(describeRedirectDestination("https://localhost.attacker.example/cb")).toEqual({
      kind: "web",
      host: "localhost.attacker.example",
    });
  });
});

describe("consentTrust", () => {
  const web = { kind: "web", host: "attacker.example.com" } as const;

  it("only an operator-flagged client is verified", () => {
    expect(consentTrust(true, web)).toBe("verified");
    expect(consentTrust(false, web)).toBe("unverified-web");
    expect(consentTrust(undefined, web)).toBe("unverified-web");
  });

  it("an unverified client redirecting locally gets the quiet tier", () => {
    expect(consentTrust(false, { kind: "local" })).toBe("unverified-local");
    expect(consentTrust(undefined, { kind: "app", scheme: "cursor" })).toBe("unverified-local");
  });

  it("an unknown destination fails closed to the warning tier", () => {
    expect(consentTrust(false, null)).toBe("unverified-web");
  });
});
