import { describe, it, expect } from "bun:test";
import { deriveSigningKey, signPayload, verifySignature } from "./webhook-sign";

describe("webhook signing", () => {
  const master = "a".repeat(64);

  it("derives a stable per-subscription key from (master, id, version)", async () => {
    const k1 = await deriveSigningKey(master, "whk_abc", 1);
    const k2 = await deriveSigningKey(master, "whk_abc", 1);
    expect(k1).toBe(k2);
  });

  it("derivation is sensitive to subscription id", async () => {
    const ka = await deriveSigningKey(master, "whk_abc", 1);
    const kb = await deriveSigningKey(master, "whk_xyz", 1);
    expect(ka).not.toBe(kb);
  });

  it("derivation is sensitive to secret_version", async () => {
    const k1 = await deriveSigningKey(master, "whk_abc", 1);
    const k2 = await deriveSigningKey(master, "whk_abc", 2);
    expect(k1).not.toBe(k2);
  });

  it("signPayload produces a hex SHA256 HMAC", async () => {
    const key = await deriveSigningKey(master, "whk_abc", 1);
    const sig = await signPayload(key, 1729281234, '{"hello":"world"}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("verifySignature accepts a matching signature", async () => {
    const key = await deriveSigningKey(master, "whk_abc", 1);
    const ts = 1729281234;
    const body = '{"hello":"world"}';
    const sig = await signPayload(key, ts, body);
    expect(await verifySignature(key, ts, body, sig)).toBe(true);
  });

  it("verifySignature rejects a mismatched signature", async () => {
    const key = await deriveSigningKey(master, "whk_abc", 1);
    const ok = await verifySignature(
      key,
      1729281234,
      '{"hello":"world"}',
      "sha256=00".padEnd(71, "0"),
    );
    expect(ok).toBe(false);
  });

  it("verifySignature is constant-time for differing-length signatures", async () => {
    const key = await deriveSigningKey(master, "whk_abc", 1);
    const ok = await verifySignature(key, 1729281234, "{}", "sha256=ab");
    expect(ok).toBe(false);
  });
});
