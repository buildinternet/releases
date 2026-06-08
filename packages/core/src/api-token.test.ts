import { describe, expect, it } from "bun:test";
import {
  FEED_TOKEN_PREFIX,
  generateFeedToken,
  parseFeedToken,
  isFeedTokenShaped,
  constantTimeEqual,
} from "./api-token.js";

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
    expect(constantTimeEqual(secret, secret.slice(0, -1) + "X")).toBe(false);
  });
});
