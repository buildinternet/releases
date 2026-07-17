import { describe, it, expect } from "bun:test";
import { isReservedSlug } from "./reserved-slugs";

describe("isReservedSlug nested scope — product-first additions", () => {
  it("reserves the static second-segment routes that bare = product introduces", () => {
    for (const slug of ["product", "products", "playbook", "fetch-log", "admin"]) {
      expect(isReservedSlug(slug, "nested")).toBe(true);
    }
  });

  it("still reserves the pre-existing org/source sub-tabs", () => {
    for (const slug of ["releases", "sources", "overview", "highlights", "changelog"]) {
      expect(isReservedSlug(slug, "nested")).toBe(true);
    }
  });

  it("does not reserve an ordinary product slug", () => {
    expect(isReservedSlug("next-js", "nested")).toBe(false);
    expect(isReservedSlug("turborepo", "nested")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isReservedSlug("Playbook", "nested")).toBe(true);
  });
});
