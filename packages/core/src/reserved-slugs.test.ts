import { describe, it, expect } from "bun:test";
import { isReservedSlug, RESERVED_ROOT_SLUGS, RESERVED_NESTED_SLUGS } from "./reserved-slugs";

describe("isReservedSlug", () => {
  it("treats root scope as default", () => {
    expect(isReservedSlug("login")).toBe(true);
    expect(isReservedSlug("about")).toBe(true);
    expect(isReservedSlug("api")).toBe(true);
  });

  it("flags web-route collisions at root scope", () => {
    for (const slug of ["api", "docs", "release", "search", "source", "status", "sitemap"]) {
      expect(isReservedSlug(slug, "root")).toBe(true);
    }
  });

  it("flags auth, admin, and entity namespaces at root scope", () => {
    for (const slug of [
      "login",
      "logout",
      "signup",
      "auth",
      "admin",
      "dashboard",
      "settings",
      "orgs",
      "products",
      "releases",
      "webhook",
      "mcp",
    ]) {
      expect(isReservedSlug(slug, "root")).toBe(true);
    }
  });

  it("normalizes case before comparing", () => {
    expect(isReservedSlug("LOGIN", "root")).toBe(true);
    expect(isReservedSlug("Admin", "root")).toBe(true);
    expect(isReservedSlug("API", "root")).toBe(true);
  });

  it("allows non-reserved slugs", () => {
    expect(isReservedSlug("vercel", "root")).toBe(false);
    expect(isReservedSlug("next-js", "root")).toBe(false);
    expect(isReservedSlug("anthropic", "root")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isReservedSlug("", "root")).toBe(false);
    expect(isReservedSlug("", "nested")).toBe(false);
  });

  it("applies a narrower list for nested scope", () => {
    // These are reserved at root but intentionally allowed under an org.
    expect(isReservedSlug("about", "nested")).toBe(false);
    expect(isReservedSlug("pricing", "nested")).toBe(false);
    expect(isReservedSlug("blog", "nested")).toBe(false);

    // These remain reserved under an org (CRUD verbs, admin paths).
    expect(isReservedSlug("new", "nested")).toBe(true);
    expect(isReservedSlug("edit", "nested")).toBe(true);
    expect(isReservedSlug("admin", "nested")).toBe(true);
    expect(isReservedSlug("api", "nested")).toBe(true);
  });

  it("exposes the underlying sets", () => {
    expect(RESERVED_ROOT_SLUGS.has("login")).toBe(true);
    expect(RESERVED_NESTED_SLUGS.has("new")).toBe(true);
    expect(RESERVED_ROOT_SLUGS.size).toBeGreaterThan(RESERVED_NESTED_SLUGS.size);
  });
});

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
