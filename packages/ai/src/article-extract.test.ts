import { describe, it, expect } from "bun:test";
import { parseArticleResponse } from "./article-extract.js";

describe("parseArticleResponse", () => {
  it("returns the verbatim article body inside the <article> tags", () => {
    const raw = "<article>\n## Heading\n\nBody text with a [link](https://x.test).\n</article>";
    expect(parseArticleResponse(raw)).toBe(
      "## Heading\n\nBody text with a [link](https://x.test).",
    );
  });

  it("returns empty string for an explicit empty <article></article> (JS-shell signal)", () => {
    expect(parseArticleResponse("<article></article>")).toBe("");
    expect(parseArticleResponse("<article>   </article>")).toBe("");
  });

  it("salvages a truncated body that has the opening tag but no closing tag", () => {
    const raw = "<article>\n## Long body that ran past the token cap\n\nMore text";
    expect(parseArticleResponse(raw)).toBe("## Long body that ran past the token cap\n\nMore text");
  });

  it("returns empty string when there is no article tag at all", () => {
    expect(parseArticleResponse("just some preamble, no tags")).toBe("");
  });
});
