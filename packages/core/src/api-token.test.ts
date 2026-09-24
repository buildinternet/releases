import { describe, expect, it } from "bun:test";
import {
  API_SCOPES,
  ROOT_SCOPE,
  isApiScope,
  scopeSatisfies,
  parseStoredScopes,
  API_TOKEN_PREFIX,
  generateApiToken,
  parseApiToken,
  isApiTokenShaped,
  FEED_TOKEN_PREFIX,
  generateFeedToken,
  parseFeedToken,
  isFeedTokenShaped,
  constantTimeEqual,
  DIGEST_TOKEN_PREFIX,
  generateDigestToken,
  isDigestTokenShaped,
  USER_API_KEY_PREFIX,
  isUserApiKeyShaped,
  hashSecret,
  DUMMY_TOKEN_HASH,
} from "./api-token.js";
import { newApiTokenId } from "./id.js";

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

describe("feed tokens (relf_)", () => {
  it("generates a relf_-prefixed token that round-trips through parse", () => {
    const { token, lookupId, secret } = generateFeedToken();
    expect(token.startsWith(FEED_TOKEN_PREFIX)).toBe(true);
    expect(token).toBe(`${FEED_TOKEN_PREFIX}${lookupId}_${secret}`);
    const parsed = parseFeedToken(token);
    expect(parsed).toEqual({ lookupId, secret });
  });

  it("isFeedTokenShaped accepts relf_ and rejects relk_/relu_", () => {
    const { token } = generateFeedToken();
    expect(isFeedTokenShaped(token)).toBe(true);
    expect(isFeedTokenShaped("relk_abc_def")).toBe(false);
    expect(isFeedTokenShaped("relu_abc")).toBe(false);
  });

  it("parseFeedToken returns null for malformed input", () => {
    expect(parseFeedToken("relf_short")).toBeNull();
    expect(parseFeedToken("not-a-token")).toBeNull();
    expect(parseFeedToken("relk_" + "a".repeat(12) + "_" + "b".repeat(32))).toBeNull();
  });

  it("constantTimeEqual matches the stored secret and rejects a wrong one", () => {
    const { secret } = generateFeedToken();
    expect(constantTimeEqual(secret, secret)).toBe(true);
    // Flip the last char to one guaranteed different from it — appending a fixed
    // letter would collide (false-negative) ~1/62 of the time when the random
    // BASE62 secret already ends in that letter.
    const last = secret.slice(-1);
    const wrong = secret.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(constantTimeEqual(secret, wrong)).toBe(false);
  });
});

describe("digest token", () => {
  it("generates a prefixed, shaped token", () => {
    const t = generateDigestToken();
    expect(t.startsWith(DIGEST_TOKEN_PREFIX)).toBe(true);
    expect(isDigestTokenShaped(t)).toBe(true);
    expect(t.length).toBeGreaterThan(DIGEST_TOKEN_PREFIX.length + 20);
  });

  it("generates distinct tokens", () => {
    expect(generateDigestToken()).not.toBe(generateDigestToken());
  });

  it("rejects non-digest shapes", () => {
    expect(isDigestTokenShaped("relf_abc")).toBe(false);
    expect(isDigestTokenShaped("relk_abc")).toBe(false);
    expect(isDigestTokenShaped("")).toBe(false);
  });
});

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

describe("user API key prefix (relu_)", () => {
  it("recognizes relu_ as a user key, not a machine token", () => {
    expect(USER_API_KEY_PREFIX).toBe("relu_");
    expect(isUserApiKeyShaped("relu_abc123")).toBe(true);
    expect(isApiTokenShaped("relu_abc123")).toBe(false); // machine check is relk_
  });

  it("keeps relk_ as the machine lane, distinct from user keys", () => {
    expect(isUserApiKeyShaped("relk_abc_def")).toBe(false);
    expect(isApiTokenShaped("relk_abc_def")).toBe(true);
  });
});
