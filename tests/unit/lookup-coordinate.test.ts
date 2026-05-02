import { describe, test, expect } from "bun:test";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";

describe("parseCoordinate", () => {
  test("parses a simple github coordinate", () => {
    expect(parseCoordinate("acme/random-sdk")).toEqual({
      provider: "github",
      org: "acme",
      repo: "random-sdk",
    });
  });

  test("parses repos with dots", () => {
    expect(parseCoordinate("vercel/next.js")).toEqual({
      provider: "github",
      org: "vercel",
      repo: "next.js",
    });
  });

  test("parses repos with underscores and hyphens", () => {
    expect(parseCoordinate("foo_bar/repo-name")).toEqual({
      provider: "github",
      org: "foo_bar",
      repo: "repo-name",
    });
  });

  test("returns null for empty string", () => {
    expect(parseCoordinate("")).toBeNull();
  });

  test("returns null for missing slash", () => {
    expect(parseCoordinate("acme")).toBeNull();
  });

  test("returns null for too many slashes", () => {
    expect(parseCoordinate("acme/random/extra")).toBeNull();
  });

  test("returns null for leading slash", () => {
    expect(parseCoordinate("/acme/repo")).toBeNull();
  });

  test("returns null for trailing slash", () => {
    expect(parseCoordinate("acme/repo/")).toBeNull();
  });

  test("returns null for empty org segment", () => {
    expect(parseCoordinate("/repo")).toBeNull();
  });

  test("returns null for empty repo segment", () => {
    expect(parseCoordinate("acme/")).toBeNull();
  });

  test("returns null for whitespace", () => {
    expect(parseCoordinate("acme /repo")).toBeNull();
    expect(parseCoordinate("acme/ repo")).toBeNull();
  });

  test("returns null for invalid characters", () => {
    expect(parseCoordinate("acme/repo!")).toBeNull();
    expect(parseCoordinate("acme/repo@1")).toBeNull();
  });

  test("returns null for unicode", () => {
    expect(parseCoordinate("acme/repó")).toBeNull();
  });

  test("trims surrounding whitespace before validating", () => {
    expect(parseCoordinate("  acme/repo  ")).toEqual({
      provider: "github",
      org: "acme",
      repo: "repo",
    });
  });

  test("accepts the optional `github:` prefix", () => {
    expect(parseCoordinate("github:acme/repo")).toEqual({
      provider: "github",
      org: "acme",
      repo: "repo",
    });
  });

  test("accepts case-variant `GitHub:` prefix (case-insensitive)", () => {
    expect(parseCoordinate("GitHub:acme/repo")).toEqual({
      provider: "github",
      org: "acme",
      repo: "repo",
    });
  });

  test("preserves the user's case in org and repo segments", () => {
    expect(parseCoordinate("Shopify/Toxiproxy")).toEqual({
      provider: "github",
      org: "Shopify",
      repo: "Toxiproxy",
    });
  });

  test("returns null for unsupported provider prefixes", () => {
    expect(parseCoordinate("npm:acme/repo")).toBeNull();
    expect(parseCoordinate("gitlab:acme/repo")).toBeNull();
  });

  test("returns null for an empty provider prefix", () => {
    expect(parseCoordinate(":acme/repo")).toBeNull();
  });
});
