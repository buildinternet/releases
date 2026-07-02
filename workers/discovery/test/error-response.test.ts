import { describe, it, expect } from "bun:test";
import { errorResponse } from "../src/error-response.js";

/**
 * The discovery worker's HTTP routes emit the platform's standardized nested
 * error envelope `{ error: { code, type, message, details? } }` (#1830, item 1)
 * — the same shape the API worker's `respondError` produces. These tests pin
 * that wire shape so a regression back to the old flat `{ error: <string> }`
 * is caught.
 */
async function bodyOf(res: Response): Promise<{ error?: Record<string, unknown> }> {
  return (await res.json()) as { error?: Record<string, unknown> };
}

describe("discovery errorResponse", () => {
  it("nests code/type/message and derives type from the status", async () => {
    const res = errorResponse("Not found", 404);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await bodyOf(res);
    expect(body.error).toEqual({ code: "not_found", type: "not_found", message: "Not found" });
  });

  it("defaults the code from the type across the status classes it uses", async () => {
    const cases: Array<[number, string, string]> = [
      [400, "validation", "validation_failed"],
      [401, "unauthorized", "unauthorized"],
      [409, "conflict", "conflict"],
      [429, "rate_limited", "rate_limited"],
      [500, "internal", "internal_error"],
      [503, "unavailable", "service_unavailable"],
    ];
    for (const [status, type, code] of cases) {
      const body = await bodyOf(errorResponse("boom", status));
      expect(body.error).toEqual({ code, type, message: "boom" });
    }
  });

  it("honors an explicit domain code (e.g. invalid_json) over the type default", async () => {
    const body = await bodyOf(errorResponse("Invalid JSON body", 400, { code: "invalid_json" }));
    expect(body.error).toMatchObject({ code: "invalid_json", type: "validation" });
  });

  it("carries structured fields in details, never at the top level", async () => {
    const res = errorResponse("dedup window", 409, {
      headers: { "Retry-After": "42" },
      details: { retryAfterSeconds: 42, existingStatus: "running" },
    });
    expect(res.headers.get("Retry-After")).toBe("42");
    const body = (await res.json()) as Record<string, unknown>;
    // No stray top-level keys beyond `error`.
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toEqual({
      code: "conflict",
      type: "conflict",
      message: "dedup window",
      details: { retryAfterSeconds: 42, existingStatus: "running" },
    });
  });

  it("omits details when none are supplied", async () => {
    const body = await bodyOf(errorResponse("plain", 500));
    expect(body.error && "details" in body.error).toBe(false);
  });
});
