import { describe, expect, it } from "bun:test";
import { codeChallengeS256, generateCodeVerifier, generateOAuthState } from "./pkce.js";

describe("pkce", () => {
  it("generates a 43-char base64url verifier", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates distinct state values", () => {
    expect(generateOAuthState()).not.toBe(generateOAuthState());
  });

  it("S256 challenge is deterministic for a verifier and URL-safe", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await codeChallengeS256(verifier);
    expect(challenge).toBe(await codeChallengeS256(verifier));
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });
});
