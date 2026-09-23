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

  it("returns a markdown 404 body when the caller asked for markdown", async () => {
    const res = formatErrorResponse(
      new ApiNotFoundError("/v1/products/x"),
      "Product not found",
      "md",
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("llms.txt");
    expect(body).toContain("404");
  });

  it("keeps the JSON error shape when format is json", async () => {
    const res = formatErrorResponse(
      new ApiNotFoundError("/v1/products/x"),
      "Product not found",
      "json",
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not_found", message: "Product not found" });
  });

  it("keeps the JSON error shape when format is atom", async () => {
    const res = formatErrorResponse(
      new ApiNotFoundError("/v1/products/x"),
      "Product not found",
      "atom",
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "Product not found" });
  });
});
