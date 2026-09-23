import { describe, expect, it } from "bun:test";
import { checkWebhookTestRateLimit } from "./test-rate-limit.js";

describe("checkWebhookTestRateLimit", () => {
  it("no-ops when limiters are absent", async () => {
    expect(await checkWebhookTestRateLimit({}, "u1", "whk_a")).toBe("ok");
  });

  it("returns sub when the per-subscription limiter rejects", async () => {
    const result = await checkWebhookTestRateLimit(
      {
        sub: { limit: async () => ({ success: false }) },
        user: { limit: async () => ({ success: true }) },
      },
      "u1",
      "whk_a",
    );
    expect(result).toBe("sub");
  });

  it("returns user when the per-user limiter rejects", async () => {
    const result = await checkWebhookTestRateLimit(
      {
        sub: { limit: async () => ({ success: true }) },
        user: { limit: async () => ({ success: false }) },
      },
      "u1",
      "whk_a",
    );
    expect(result).toBe("user");
  });
});
