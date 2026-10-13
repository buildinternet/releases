import { describe, expect, test } from "bun:test";
import { listedBadgeImageUrl, listedBadgeSnippets } from "./listed-badge";

describe("listedBadgeSnippets", () => {
  test("links the org page and serves the badge from the same origin", () => {
    const { html, markdown } = listedBadgeSnippets("https://releases.sh/acme", "light");
    expect(html).toBe(
      '<a href="https://releases.sh/acme"><img src="https://releases.sh/badges/listed.svg" alt="Release Notes Index" width="118" height="24"></a>',
    );
    expect(markdown).toBe(
      "[![Release Notes Index](https://releases.sh/badges/listed.svg)](https://releases.sh/acme)",
    );
  });

  test("dark theme swaps only the image", () => {
    const { html } = listedBadgeSnippets("https://releases.sh/acme", "dark");
    expect(html).toContain('src="https://releases.sh/badges/listed-dark.svg"');
    expect(html).toContain('href="https://releases.sh/acme"');
  });

  test("image path is relative without an org URL (in-app previews)", () => {
    expect(listedBadgeImageUrl("dark")).toBe("/badges/listed-dark.svg");
  });
});
