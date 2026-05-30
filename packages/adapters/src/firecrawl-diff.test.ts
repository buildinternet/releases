import { expect, it } from "bun:test";
import { addedContentFromDiff } from "./firecrawl-diff.js";

it("returns the added lines verbatim, stripped of the + prefix", () => {
  const diff = [
    "--- previous",
    "+++ current",
    "@@ -1,2 +1,5 @@",
    " # Release Notes",
    "+",
    "+## January 15, 2026",
    "+- New feature X",
    "+- Fix Y",
    " ## January 1, 2026",
  ].join("\n");

  expect(addedContentFromDiff(diff)).toBe(
    ["## January 15, 2026", "- New feature X", "- Fix Y"].join("\n"),
  );
});

it("drops file headers, hunk headers, context, and removed lines", () => {
  const diff = [
    "--- previous",
    "+++ current",
    "@@ -1,3 +1,3 @@",
    " # Pricing",
    "-Starter — $19/mo",
    "+Starter — $24/mo",
  ].join("\n");

  // Only the post-change pricing line survives; the removed line and the
  // unchanged "# Pricing" context line are dropped.
  expect(addedContentFromDiff(diff)).toBe("Starter — $24/mo");
});

it("keeps added content that itself begins with dashes", () => {
  // Inside a hunk a leading '+' is the add marker; the rest is content. An added
  // line whose content starts with '--' must not be mistaken for a '---' header.
  const diff = ["@@ -0,0 +1,2 @@", "+-- a comment", "+- a bullet"].join("\n");
  expect(addedContentFromDiff(diff)).toBe(["-- a comment", "- a bullet"].join("\n"));
});

it("keeps added content that itself begins with plus signs", () => {
  // Symmetric to the dash case: an added line whose content starts with '++'
  // renders as '+++…' and must not be mistaken for a '+++' file header.
  const diff = ["@@ -0,0 +1,2 @@", "+++ a comment", "++ a bullet"].join("\n");
  expect(addedContentFromDiff(diff)).toBe(["++ a comment", "+ a bullet"].join("\n"));
});

it("returns empty string when there is nothing added", () => {
  expect(addedContentFromDiff("")).toBe("");
  expect(
    addedContentFromDiff(
      ["--- previous", "+++ current", "@@ -1,2 +1,1 @@", " keep", "-gone"].join("\n"),
    ),
  ).toBe("");
});

it("extracts added lines from a hunkless full-document diff (live monitor.page format)", () => {
  // Firecrawl's live monitor.page webhook does NOT send the documented unified
  // diff: there are no @@ hunk headers and no ---/+++ file headers. The whole
  // page is one diff body where every line is prefixed with a single space
  // (context), '+' (added) or '-' (removed). Shape captured verbatim from monitor
  // 019e75bb… check 019e7778… (the OpenAI ChatGPT release-notes change, 2026-05-30).
  const diff = [
    " # ChatGPT — Release Notes",
    " ",
    "-Updated: 7 hours ago",
    "+Updated: 5 hours ago",
    " ",
    "+# May 29, 2026",
    "+",
    "+## Codex updates: Computer use on Windows",
    " ",
    " # May 28, 2026",
  ].join("\n");

  // The changed "Updated: N hours ago" stamp is itself a '+' line so it leaks
  // through (downstream extraction ignores non-release prose). The blank line
  // between the two timestamps is a dropped *context* line, so it does not; the
  // blank inside the new entry is a '+' line, so it does.
  expect(addedContentFromDiff(diff)).toBe(
    [
      "Updated: 5 hours ago",
      "# May 29, 2026",
      "",
      "## Codex updates: Computer use on Windows",
    ].join("\n"),
  );
});

it("returns empty for a hunkless diff that only removes or keeps lines", () => {
  const diff = [" # Pricing", "-Starter — $19/mo", " Pro — $99/mo"].join("\n");
  expect(addedContentFromDiff(diff)).toBe("");
});

it("treats a leading '+' line in a hunkless diff as added content, not a file header", () => {
  // Without an @@ anchor there is no preamble to skip, so a '+++…' line is an
  // added line whose body starts with '++', mirroring the in-hunk behavior above.
  const diff = ["+++ added heading", " context"].join("\n");
  expect(addedContentFromDiff(diff)).toBe("++ added heading");
});
