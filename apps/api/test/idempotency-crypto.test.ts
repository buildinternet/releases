import { describe, expect, test } from "bun:test";
import {
  decryptIdempotencyBody,
  encryptIdempotencyBody,
  type ResponseBinding,
} from "../src/lib/idempotency-crypto";

const RAW_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const OTHER_RAW_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const BINDING: ResponseBinding = {
  principalHash: "p".repeat(64),
  keyHash: "k".repeat(64),
  requestHash: "r".repeat(64),
  status: 201,
};

function mutateBase64(value: string): string {
  const replacement = value[0] === "A" ? "B" : "A";
  return `${replacement}${value.slice(1)}`;
}

describe("idempotency response encryption", () => {
  test("a literal 32-byte base64 key round-trips arbitrary bytes without plaintext storage", async () => {
    const plaintext = new Uint8Array([0, 1, 2, 127, 128, 254, 255, 65, 66, 67]);

    const envelope = await encryptIdempotencyBody(plaintext, RAW_KEY, BINDING);

    expect(envelope).not.toContain("ABC");
    expect(await decryptIdempotencyBody(envelope, RAW_KEY, BINDING)).toEqual(plaintext);
  });

  test("each encryption uses a distinct 96-bit IV", async () => {
    const plaintext = new TextEncoder().encode("same response");

    const first = JSON.parse(await encryptIdempotencyBody(plaintext, RAW_KEY, BINDING)) as {
      iv: string;
    };
    const second = JSON.parse(await encryptIdempotencyBody(plaintext, RAW_KEY, BINDING)) as {
      iv: string;
    };

    expect(first.iv).not.toBe(second.iv);
    expect(Uint8Array.from(atob(first.iv), (char) => char.charCodeAt(0))).toHaveLength(12);
    expect(Uint8Array.from(atob(second.iv), (char) => char.charCodeAt(0))).toHaveLength(12);
  });

  test("malformed base64 and keys that are not exactly 32 bytes fail closed", async () => {
    const plaintext = new Uint8Array([1]);

    await expect(encryptIdempotencyBody(plaintext, "not-base64", BINDING)).rejects.toThrow();
    await expect(encryptIdempotencyBody(plaintext, "AA==", BINDING)).rejects.toThrow();
    await expect(
      encryptIdempotencyBody(plaintext, `${RAW_KEY.slice(0, -1)}!`, BINDING),
    ).rejects.toThrow();
  });

  test("AAD authenticates status, principal, idempotency key, and request fingerprints", async () => {
    const envelope = await encryptIdempotencyBody(
      new TextEncoder().encode("bound response"),
      RAW_KEY,
      BINDING,
    );
    const changedBindings: ResponseBinding[] = [
      { ...BINDING, status: 202 },
      { ...BINDING, principalHash: "q".repeat(64) },
      { ...BINDING, keyHash: "x".repeat(64) },
      { ...BINDING, requestHash: "s".repeat(64) },
    ];

    for (const binding of changedBindings) {
      await expect(decryptIdempotencyBody(envelope, RAW_KEY, binding)).rejects.toThrow();
    }
  });

  test("tampered IV and ciphertext fail authentication", async () => {
    const envelope = JSON.parse(
      await encryptIdempotencyBody(new TextEncoder().encode("untampered"), RAW_KEY, BINDING),
    ) as { v: number; kid: string; iv: string; ciphertext: string };

    await expect(
      decryptIdempotencyBody(
        JSON.stringify({ ...envelope, iv: mutateBase64(envelope.iv) }),
        RAW_KEY,
        BINDING,
      ),
    ).rejects.toThrow();
    await expect(
      decryptIdempotencyBody(
        JSON.stringify({ ...envelope, ciphertext: mutateBase64(envelope.ciphertext) }),
        RAW_KEY,
        BINDING,
      ),
    ).rejects.toThrow();
  });

  test("a different valid key fails the stored key-fingerprint check", async () => {
    const envelope = await encryptIdempotencyBody(
      new TextEncoder().encode("secret response"),
      RAW_KEY,
      BINDING,
    );

    await expect(decryptIdempotencyBody(envelope, OTHER_RAW_KEY, BINDING)).rejects.toThrow();
  });
});
