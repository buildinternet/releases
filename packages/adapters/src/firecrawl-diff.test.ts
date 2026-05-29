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
