import { describe, it, expect } from "bun:test";
import { verifySignatureCli } from "./webhook-verify.js";
import { signPayload } from "@releases/core/webhook-sign";

describe("webhook verify CLI helper", () => {
  it("returns ok=true on a matching signature", async () => {
    const key = "deadbeef".repeat(8);
    const ts = 1729281234;
    const body = '{"hello":"world"}';
    const sig = await signPayload(key, ts, body);
    const result = await verifySignatureCli({ secret: key, timestamp: ts, signature: sig, body });
    expect(result.ok).toBe(true);
  });

  it("returns ok=false on a mismatch", async () => {
    const result = await verifySignatureCli({
      secret: "deadbeef".repeat(8),
      timestamp: 1,
      signature: "sha256=00",
      body: "{}",
    });
    expect(result.ok).toBe(false);
  });
});
