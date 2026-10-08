import { describe, it, expect } from "bun:test";
import { verifyWebhookPayload, MAX_SKEW_SECONDS } from "../../src/cli/commands/webhook.js";

// Helpers — sign a payload the same way the server does so tests are self-contained.
const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, "0");
  return out;
}

async function sign(keyHex: string, timestampSec: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(keyHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestampSec}.${body}`));
  return `sha256=${bytesToHex(buf)}`;
}

// A deterministic 32-byte hex key for all tests.
const KEY_HEX = "a".repeat(64); // 64 hex chars = 32 bytes
const BODY = '{"type":"release.created"}';
const NOW_MS = 1_700_000_000_000; // arbitrary fixed "now"
const NOW_SEC = Math.floor(NOW_MS / 1000);

describe("verifyWebhookPayload", () => {
  it("passes for a valid signature within the time window", async () => {
    const ts = NOW_SEC; // exactly "now"
    const sig = await sign(KEY_HEX, ts, BODY);
    const result = await verifyWebhookPayload({
      signingKeyHex: KEY_HEX,
      timestampHeader: String(ts),
      rawBody: BODY,
      signatureHeader: sig,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails for a 6-minute-old timestamp without --allow-stale", async () => {
    const ts = NOW_SEC - (MAX_SKEW_SECONDS + 60); // 6 minutes in the past
    const sig = await sign(KEY_HEX, ts, BODY);
    const result = await verifyWebhookPayload({
      signingKeyHex: KEY_HEX,
      timestampHeader: String(ts),
      rawBody: BODY,
      signatureHeader: sig,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_outside_window" });
  });

  it("passes for a 6-minute-old timestamp with allowStale=true", async () => {
    const ts = NOW_SEC - (MAX_SKEW_SECONDS + 60); // 6 minutes in the past
    const sig = await sign(KEY_HEX, ts, BODY);
    const result = await verifyWebhookPayload({
      signingKeyHex: KEY_HEX,
      timestampHeader: String(ts),
      rawBody: BODY,
      signatureHeader: sig,
      allowStale: true,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails with signature_mismatch when the body has been tampered with", async () => {
    const ts = NOW_SEC;
    const sig = await sign(KEY_HEX, ts, BODY);
    const result = await verifyWebhookPayload({
      signingKeyHex: KEY_HEX,
      timestampHeader: String(ts),
      rawBody: '{"type":"release.deleted"}', // tampered
      signatureHeader: sig,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("fails with invalid_timestamp when the header is non-numeric", async () => {
    const result = await verifyWebhookPayload({
      signingKeyHex: KEY_HEX,
      timestampHeader: "not-a-number",
      rawBody: BODY,
      signatureHeader: "sha256=abc",
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("fails with invalid_timestamp for an empty timestamp header", async () => {
    const result = await verifyWebhookPayload({
      signingKeyHex: KEY_HEX,
      timestampHeader: "",
      rawBody: BODY,
      signatureHeader: "sha256=abc",
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("passes for a timestamp at exactly the edge of the window", async () => {
    const ts = NOW_SEC - MAX_SKEW_SECONDS; // exactly on the boundary (inclusive)
    const sig = await sign(KEY_HEX, ts, BODY);
    const result = await verifyWebhookPayload({
      signingKeyHex: KEY_HEX,
      timestampHeader: String(ts),
      rawBody: BODY,
      signatureHeader: sig,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails for a timestamp 1 second beyond the window", async () => {
    const ts = NOW_SEC - MAX_SKEW_SECONDS - 1;
    const sig = await sign(KEY_HEX, ts, BODY);
    const result = await verifyWebhookPayload({
      signingKeyHex: KEY_HEX,
      timestampHeader: String(ts),
      rawBody: BODY,
      signatureHeader: sig,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_outside_window" });
  });

  it("rejects a numeric-prefix timestamp ('<real>junk') that parseInt would silently accept", async () => {
    const result = await verifyWebhookPayload({
      signingKeyHex: KEY_HEX,
      timestampHeader: `${NOW_SEC}junk`,
      rawBody: BODY,
      signatureHeader: "sha256=abc",
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it('verifies an empty body when --body "" is used (truthy check would have rejected it)', async () => {
    const ts = NOW_SEC;
    const sig = await sign(KEY_HEX, ts, "");
    const result = await verifyWebhookPayload({
      signingKeyHex: KEY_HEX,
      timestampHeader: String(ts),
      rawBody: "",
      signatureHeader: sig,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });
});
