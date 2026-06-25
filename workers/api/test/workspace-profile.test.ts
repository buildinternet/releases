import { test, expect } from "bun:test";
import {
  mergeWorkspaceMetadata,
  normalizeGithubHandle,
  normalizeProfilePatch,
  normalizeProfileUrl,
  parseWorkspaceProfile,
} from "../src/lib/workspace-profile.js";

test("parseWorkspaceProfile reads stored JSON fields", () => {
  expect(
    parseWorkspaceProfile(
      JSON.stringify({
        websiteUrl: "https://acme.com",
        changelogUrl: "https://acme.com/changelog",
        githubHandle: "acme",
      }),
    ),
  ).toEqual({
    websiteUrl: "https://acme.com",
    changelogUrl: "https://acme.com/changelog",
    githubHandle: "acme",
  });
});

test("mergeWorkspaceMetadata patches and clears fields", () => {
  const existing = JSON.stringify({ websiteUrl: "https://old.com", extra: true });
  const next = mergeWorkspaceMetadata(existing, {
    websiteUrl: null,
    githubHandle: "acme",
  });
  expect(JSON.parse(next)).toEqual({ extra: true, githubHandle: "acme" });
});

test("normalizeGithubHandle accepts handles and profile URLs", () => {
  expect(normalizeGithubHandle("Acme")).toBe("acme");
  expect(normalizeGithubHandle("@acme")).toBe("acme");
  expect(normalizeGithubHandle("https://github.com/acme")).toBe("acme");
  expect(normalizeGithubHandle("not a handle!!!")).toBeNull();
});

test("normalizeProfileUrl rejects private hosts", () => {
  expect(normalizeProfileUrl("https://example.com/about")).toBe("https://example.com/about");
  expect(normalizeProfileUrl("http://localhost:3000")).toBeNull();
  expect(normalizeProfileUrl("ftp://example.com")).toBeNull();
});

test("normalizeProfilePatch validates and normalizes partial updates", () => {
  expect(
    normalizeProfilePatch({
      websiteUrl: "https://acme.com",
      githubHandle: "https://github.com/acme",
    }),
  ).toEqual({
    ok: true,
    patch: { websiteUrl: "https://acme.com/", githubHandle: "acme" },
  });
  expect(normalizeProfilePatch({ websiteUrl: "not-a-url" })).toEqual({
    ok: false,
    message: "websiteUrl must be a valid public URL",
  });
});
