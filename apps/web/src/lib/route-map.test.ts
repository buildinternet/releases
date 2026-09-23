import { describe, expect, it } from "bun:test";
import { routeMap } from "./route-map";

describe("routeMap — collection digests", () => {
  it("maps the digests index to the format route", () => {
    expect(routeMap("/collections/frontier-ai-labs/digest")).toBe(
      "/api/format/collections/frontier-ai-labs/digest",
    );
  });

  it("maps a week page to the format route", () => {
    expect(routeMap("/collections/frontier-ai-labs/digest/2026-07-06")).toBe(
      "/api/format/collections/frontier-ai-labs/digest/2026-07-06",
    );
  });

  it("still maps the collection itself", () => {
    expect(routeMap("/collections/frontier-ai-labs")).toBe(
      "/api/format/collections/frontier-ai-labs",
    );
  });

  it("still maps categories", () => {
    expect(routeMap("/categories/ai")).toBe("/api/format/categories/ai");
  });
});
