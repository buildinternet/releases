import { describe, expect, it } from "bun:test";
import {
  coerceExplicitWebToNativeForPrivateUseScheme,
  defaultRegistrationApplicationType,
  isLoopbackHttpRedirect,
  isPrivateUseSchemeRedirect,
  isValidNativeRedirect,
} from "./oauth-application-type.js";

describe("isLoopbackHttpRedirect", () => {
  it("accepts http on localhost/127.0.0.1/[::1]", () => {
    expect(isLoopbackHttpRedirect("http://127.0.0.1:19876/mcp/oauth/callback")).toBe(true);
    expect(isLoopbackHttpRedirect("http://localhost:8080/callback")).toBe(true);
    expect(isLoopbackHttpRedirect("http://[::1]:8080/callback")).toBe(true);
  });

  it("rejects a lookalike host", () => {
    expect(isLoopbackHttpRedirect("http://127.0.0.1.evil.com/callback")).toBe(false);
  });

  it("rejects https and non-loopback http", () => {
    expect(isLoopbackHttpRedirect("https://127.0.0.1/callback")).toBe(false);
    expect(isLoopbackHttpRedirect("http://example.com/callback")).toBe(false);
  });

  it("fails closed on an unparseable URI", () => {
    expect(isLoopbackHttpRedirect("not a uri")).toBe(false);
  });
});

describe("isPrivateUseSchemeRedirect", () => {
  it("accepts custom schemes", () => {
    expect(isPrivateUseSchemeRedirect("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
    expect(isPrivateUseSchemeRedirect("com.example.app:/callback")).toBe(true);
  });

  it("rejects http/https", () => {
    expect(isPrivateUseSchemeRedirect("http://127.0.0.1/callback")).toBe(false);
    expect(isPrivateUseSchemeRedirect("https://example.com/callback")).toBe(false);
  });

  it("fails closed on an unparseable URI", () => {
    expect(isPrivateUseSchemeRedirect("not a uri")).toBe(false);
  });
});

describe("isValidNativeRedirect", () => {
  it("accepts loopback http, private-use scheme, and non-loopback https", () => {
    expect(isValidNativeRedirect("http://127.0.0.1:8080/callback")).toBe(true);
    expect(isValidNativeRedirect("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
    expect(isValidNativeRedirect("https://cursor.com/oauth/callback")).toBe(true);
  });

  it("rejects https on a loopback host", () => {
    expect(isValidNativeRedirect("https://127.0.0.1/callback")).toBe(false);
    expect(isValidNativeRedirect("https://localhost/callback")).toBe(false);
  });

  it("fails closed on an unparseable URI", () => {
    expect(isValidNativeRedirect("not a uri")).toBe(false);
  });
});

describe("defaultRegistrationApplicationType", () => {
  it("defaults the opencode shape (bare loopback body) to native", () => {
    const body = {
      client_name: "opencode",
      redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
      token_endpoint_auth_method: "none",
    };
    const out = defaultRegistrationApplicationType(body);
    expect(out).toEqual({ ...body, application_type: "native" });
    // never mutates the input
    expect(body).not.toHaveProperty("application_type");
  });

  it("does not default a lookalike-host redirect", () => {
    const body = {
      client_name: "evil",
      redirect_uris: ["http://127.0.0.1.evil.com/callback"],
    };
    expect(defaultRegistrationApplicationType(body)).toBeUndefined();
  });

  it("defaults when application_type is omitted with mixed private-use + https non-loopback", () => {
    const body = {
      client_name: "cursor-like",
      redirect_uris: [
        "cursor://anysphere.cursor-mcp/oauth/callback",
        "https://cursor.com/oauth/callback",
      ],
    };
    expect(defaultRegistrationApplicationType(body)).toEqual({
      ...body,
      application_type: "native",
    });
  });

  it("does not default mixed private-use + https-loopback (not valid-native)", () => {
    const body = {
      client_name: "mixed",
      redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback", "https://127.0.0.1/callback"],
    };
    expect(defaultRegistrationApplicationType(body)).toBeUndefined();
  });

  it("leaves explicit application_type alone", () => {
    const body = {
      redirect_uris: ["http://127.0.0.1:8080/callback"],
      application_type: "web",
    };
    expect(defaultRegistrationApplicationType(body)).toBeUndefined();
  });

  it("handles malformed bodies (no redirect_uris, non-array, non-string entries, unparseable)", () => {
    expect(defaultRegistrationApplicationType({ client_name: "x" })).toBeUndefined();
    expect(defaultRegistrationApplicationType({ redirect_uris: "not-an-array" })).toBeUndefined();
    expect(defaultRegistrationApplicationType({ redirect_uris: [] })).toBeUndefined();
    expect(defaultRegistrationApplicationType({ redirect_uris: [123] })).toBeUndefined();
    expect(
      defaultRegistrationApplicationType({ redirect_uris: ["not a uri", "also not a uri"] }),
    ).toBeUndefined();
  });
});

describe("coerceExplicitWebToNativeForPrivateUseScheme", () => {
  it("coerces the real Cursor shape (explicit web + cursor:// + https)", () => {
    const body = {
      client_name: "Cursor",
      application_type: "web",
      redirect_uris: [
        "cursor://anysphere.cursor-mcp/oauth/callback",
        "https://cursor.com/oauth/callback",
      ],
    };
    const out = coerceExplicitWebToNativeForPrivateUseScheme(body);
    expect(out).toEqual({ ...body, application_type: "native" });
    expect(body.application_type).toBe("web");
  });

  it("does not coerce web + loopback-only http", () => {
    const body = {
      application_type: "web",
      redirect_uris: ["http://127.0.0.1:8080/callback"],
    };
    expect(coerceExplicitWebToNativeForPrivateUseScheme(body)).toBeUndefined();
  });

  it("does not coerce web + pure https", () => {
    const body = {
      application_type: "web",
      redirect_uris: ["https://example.com/callback"],
    };
    expect(coerceExplicitWebToNativeForPrivateUseScheme(body)).toBeUndefined();
  });

  it("does not touch explicit native", () => {
    const body = {
      application_type: "native",
      redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
    };
    expect(coerceExplicitWebToNativeForPrivateUseScheme(body)).toBeUndefined();
  });

  it("does not coerce mixed private-use + https-loopback", () => {
    const body = {
      application_type: "web",
      redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback", "https://127.0.0.1/callback"],
    };
    expect(coerceExplicitWebToNativeForPrivateUseScheme(body)).toBeUndefined();
  });

  it("handles malformed bodies", () => {
    expect(
      coerceExplicitWebToNativeForPrivateUseScheme({ application_type: "web" }),
    ).toBeUndefined();
    expect(
      coerceExplicitWebToNativeForPrivateUseScheme({
        application_type: "web",
        redirect_uris: "nope",
      }),
    ).toBeUndefined();
  });
});
