import { describe, expect, it } from "bun:test";
import {
  decryptOAuthSecret,
  encryptOAuthSecret,
  validateOAuthTokenEncryptionKey,
} from "./oauth-token-crypto.js";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const BINDING = {
  workspaceId: "ws_1",
  provider: "uploads" as const,
  field: "access_token" as const,
};

describe("oauth-token-crypto", () => {
  it("rejects a key that is not 32 base64 bytes", () => {
    expect(() => validateOAuthTokenEncryptionKey("short")).toThrow();
  });

  it("round-trips plaintext and does not embed it in the envelope", async () => {
    const envelope = await encryptOAuthSecret("up_secret_token", KEY, BINDING);
    expect(envelope).not.toContain("up_secret_token");
    expect(await decryptOAuthSecret(envelope, KEY, BINDING)).toBe("up_secret_token");
  });

  it("uses a unique IV per encryption", async () => {
    const a = await encryptOAuthSecret("same", KEY, BINDING);
    const b = await encryptOAuthSecret("same", KEY, BINDING);
    expect(a).not.toBe(b);
  });

  it("fails when AAD field or workspace changes", async () => {
    const envelope = await encryptOAuthSecret("tok", KEY, BINDING);
    await expect(
      decryptOAuthSecret(envelope, KEY, { ...BINDING, field: "refresh_token" }),
    ).rejects.toThrow();
    await expect(
      decryptOAuthSecret(envelope, KEY, { ...BINDING, workspaceId: "ws_other" }),
    ).rejects.toThrow();
  });
});
