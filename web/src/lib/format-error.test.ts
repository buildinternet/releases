import { describe, it, expect } from "bun:test";
import { formatErrorResponse } from "./format-error.js";
import { ApiNotFoundError } from "./api.js";

describe("formatErrorResponse", () => {
  it("maps ApiNotFoundError to 404 not_found with the supplied message", async () => {
    const res = formatErrorResponse(new ApiNotFoundError("/v1/products/x"), "Product not found");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "Product not found" });
  });

  it("maps any non-404 failure to 502 bad_gateway (not misclassified as not_found)", async () => {
    const res = formatErrorResponse(new Error("API error: 503"), "Product not found");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "bad_gateway", message: "Upstream API error" });
  });
});
