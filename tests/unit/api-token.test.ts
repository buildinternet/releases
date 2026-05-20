import { describe, it, expect } from "bun:test";
import {
  API_SCOPES,
  ROOT_SCOPE,
  isApiScope,
  scopeSatisfies,
  parseStoredScopes,
} from "@buildinternet/releases-core/api-token";
import { newApiTokenId } from "@buildinternet/releases-core/id";

describe("scope vocabulary", () => {
  it("exposes the closed v1 vocabulary", () => {
    expect([...API_SCOPES]).toEqual(["read", "write", "admin"]);
  });

  it("isApiScope accepts known scopes and rejects others", () => {
    expect(isApiScope("read")).toBe(true);
    expect(isApiScope("admin")).toBe(true);
    expect(isApiScope("*")).toBe(false);
    expect(isApiScope("orgs:write")).toBe(false);
  });
});

describe("scopeSatisfies", () => {
  it("wildcard satisfies everything", () => {
    expect(scopeSatisfies([ROOT_SCOPE], "admin")).toBe(true);
    expect(scopeSatisfies([ROOT_SCOPE], "read")).toBe(true);
  });

  it("higher scopes satisfy lower ones (admin ⊇ write ⊇ read)", () => {
    expect(scopeSatisfies(["admin"], "write")).toBe(true);
    expect(scopeSatisfies(["admin"], "read")).toBe(true);
    expect(scopeSatisfies(["write"], "read")).toBe(true);
  });

  it("lower scopes do NOT satisfy higher ones", () => {
    expect(scopeSatisfies(["read"], "write")).toBe(false);
    expect(scopeSatisfies(["write"], "admin")).toBe(false);
  });

  it("unknown scopes grant nothing", () => {
    expect(scopeSatisfies(["orgs:write"], "read")).toBe(false);
    expect(scopeSatisfies([], "read")).toBe(false);
  });
});

describe("parseStoredScopes", () => {
  it("returns the string array for a valid JSON array", () => {
    expect(parseStoredScopes('["read","write"]')).toEqual(["read", "write"]);
    expect(parseStoredScopes("[]")).toEqual([]);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseStoredScopes("not json")).toEqual([]);
    expect(parseStoredScopes("")).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseStoredScopes('{"a":1}')).toEqual([]);
    expect(parseStoredScopes("null")).toEqual([]);
    expect(parseStoredScopes('"read"')).toEqual([]);
  });

  it("drops non-string elements", () => {
    expect(parseStoredScopes('["read", 123, null, "write"]')).toEqual(["read", "write"]);
  });
});

describe("newApiTokenId", () => {
  it("has the tok_ prefix", () => {
    expect(newApiTokenId()).toMatch(/^tok_/);
  });
});

import {
  API_TOKEN_PREFIX,
  generateApiToken,
  parseApiToken,
  isApiTokenShaped,
} from "@buildinternet/releases-core/api-token";

describe("generateApiToken", () => {
  it("produces relk_<12>_<32> with base62 fields", () => {
    const { token, lookupId, secret } = generateApiToken();
    expect(token).toBe(`${API_TOKEN_PREFIX}${lookupId}_${secret}`);
    expect(lookupId).toMatch(/^[0-9A-Za-z]{12}$/);
    expect(secret).toMatch(/^[0-9A-Za-z]{32}$/);
  });

  it("is unique across calls", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.token).not.toBe(b.token);
  });
});

describe("parseApiToken", () => {
  it("round-trips a generated token", () => {
    const { token, lookupId, secret } = generateApiToken();
    expect(parseApiToken(token)).toEqual({ lookupId, secret });
  });

  it("trims surrounding whitespace", () => {
    const { token, lookupId, secret } = generateApiToken();
    expect(parseApiToken(`  ${token}  `)).toEqual({ lookupId, secret });
  });

  it("returns null for malformed input", () => {
    expect(parseApiToken("")).toBeNull();
    expect(parseApiToken("relk_short_secret")).toBeNull();
    expect(parseApiToken("nope_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeNull();
    expect(parseApiToken("relk_aaaaaaaaaaaa")).toBeNull(); // no secret segment
  });
});

describe("isApiTokenShaped", () => {
  it("matches the prefix without validating content", () => {
    expect(isApiTokenShaped("relk_anything")).toBe(true);
    expect(isApiTokenShaped("some-other-secret")).toBe(false);
  });
});

import {
  hashSecret,
  constantTimeEqual,
  DUMMY_TOKEN_HASH,
} from "@buildinternet/releases-core/api-token";

describe("hashSecret", () => {
  it("returns a 64-char lowercase hex SHA-256", async () => {
    const h = await hashSecret("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // SHA-256("abc")
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is deterministic and differs by input", async () => {
    expect(await hashSecret("x")).toBe(await hashSecret("x"));
    expect(await hashSecret("x")).not.toBe(await hashSecret("y"));
  });
});

describe("constantTimeEqual", () => {
  it("true for equal strings, false otherwise", () => {
    expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
    expect(constantTimeEqual("abcdef", "abcdeg")).toBe(false);
    expect(constantTimeEqual("abc", "abcdef")).toBe(false);
  });

  it("DUMMY_TOKEN_HASH is a 64-char hex string", () => {
    expect(DUMMY_TOKEN_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});
