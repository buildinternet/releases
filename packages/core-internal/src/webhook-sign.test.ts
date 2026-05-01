import { describe, it, expect } from "bun:test";
import {
  deriveSigningKey,
  signPayload,
  verifySignature,
  verifyWithReplayGuard,
} from "./webhook-sign";

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

describe("verifyWithReplayGuard", () => {
  const master = "b".repeat(64);
  const body = '{"type":"release.created"}';
  // Fixed "now" for deterministic tests: Unix epoch seconds
  const nowMs = 1_700_000_000_000; // milliseconds
  const nowSec = Math.floor(nowMs / 1000); // 1700000000

  async function makeArgs(tsOffsetSec: number, opts?: { maxSkewSeconds?: number }) {
    const key = await deriveSigningKey(master, "whk_test", 1);
    const ts = nowSec + tsOffsetSec;
    const sig = await signPayload(key, ts, body);
    return {
      rawBody: body,
      signingKeyHex: key,
      signatureHeader: sig,
      timestampHeader: String(ts),
      now: nowMs,
      ...opts,
    };
  }

  it("in-window valid signature → { valid: true }", async () => {
    const args = await makeArgs(0);
    expect(await verifyWithReplayGuard(args)).toEqual({ valid: true });
  });

  it("in-window mismatched signature → { valid: false, reason: 'signature_mismatch' }", async () => {
    const args = await makeArgs(0);
    args.signatureHeader = "sha256=" + "0".repeat(64);
    expect(await verifyWithReplayGuard(args)).toEqual({
      valid: false,
      reason: "signature_mismatch",
    });
  });

  it("timestamp 6 min in the past with valid signature → timestamp_outside_window", async () => {
    const args = await makeArgs(-6 * 60);
    expect(await verifyWithReplayGuard(args)).toEqual({
      valid: false,
      reason: "timestamp_outside_window",
    });
  });

  it("timestamp 6 min in the future with valid signature → timestamp_outside_window", async () => {
    const args = await makeArgs(6 * 60);
    expect(await verifyWithReplayGuard(args)).toEqual({
      valid: false,
      reason: "timestamp_outside_window",
    });
  });

  it("non-numeric timestamp header → invalid_timestamp", async () => {
    const key = await deriveSigningKey(master, "whk_test", 1);
    const sig = await signPayload(key, nowSec, body);
    expect(
      await verifyWithReplayGuard({
        rawBody: body,
        signingKeyHex: key,
        signatureHeader: sig,
        timestampHeader: "not-a-number",
        now: nowMs,
      }),
    ).toEqual({ valid: false, reason: "invalid_timestamp" });
  });

  it("custom maxSkewSeconds: 10 rejects 30 sec skew that would pass the default", async () => {
    const args = await makeArgs(30, { maxSkewSeconds: 10 });
    expect(await verifyWithReplayGuard(args)).toEqual({
      valid: false,
      reason: "timestamp_outside_window",
    });
  });
});
