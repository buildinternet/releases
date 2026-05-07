import { describe, it, expect } from "bun:test";
import { stripVolatileMarkup } from "@releases/adapters/feed";

/**
 * Covers the regex sweep that backs the `body-hash-filtered` change detector
 * (#789). The contract is narrow: given two inputs that differ only in
 * volatile markup (script tags, style tags, link/meta tags, HTML comments),
 * the filtered output must be byte-identical so SHA-256 over it produces the
 * same hash. Article markup must survive untouched.
 */

async function sha256(s: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("stripVolatileMarkup", () => {
  it("strips inline scripts including type=module and multi-line bodies", () => {
    const input = `<div>before</div>
<script>console.log("a");</script>
<script type="module" src="/_next/chunk-abc123.js"></script>
<script type="application/json" id="__NEXT_DATA__">
  {"props":{"x":1}}
</script>
<div>after</div>`;
    const out = stripVolatileMarkup(input);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("</script>");
    expect(out).toContain("<div>before</div>");
    expect(out).toContain("<div>after</div>");
  });

  it("strips style and link tags (any attrs, with or without trailing slash)", () => {
    const input = `<link rel="preload" href="/_next/x.css" as="style"/>
<link rel="stylesheet" href="/main.css">
<style>body{color:red}</style>
<style data-emotion="css">.x{margin:0}</style>
<p>kept</p>`;
    const out = stripVolatileMarkup(input);
    expect(out).not.toContain("<link");
    expect(out).not.toContain("<style");
    expect(out).not.toContain("</style>");
    expect(out).toContain("<p>kept</p>");
  });

  it("strips meta tags and HTML comments (including Next.js hydration markers)", () => {
    const input = `<meta charset="utf-8">
<meta name="csrf" content="abc123xyz"/>
<!-- comment -->
<!--$-->
<article>kept</article>
<!--/$-->
<!-- multi
line
comment -->`;
    const out = stripVolatileMarkup(input);
    expect(out).not.toContain("<meta");
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("-->");
    expect(out).toContain("<article>kept</article>");
  });

  it("produces byte-identical output for two SSR bodies that differ only in volatile markup", async () => {
    const article = `<main>
  <article>
    <h2>Lightfield 2.5</h2>
    <p>New telemetry hooks.</p>
  </article>
</main>`;

    const renderA = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<link rel="preload" href="/_next/static/chunks/aaa.js" as="script"/>
<style data-emotion="css">.x-1{margin:0}</style>
<script>self.__NEXT_DATA__={"buildId":"abc","tokens":{"a":1}}</script>
</head><body>
<!--$-->
${article}
<!--/$-->
<script src="/_next/static/chunks/bbb-${Math.random()}.js"></script>
</body></html>`;

    const renderB = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<link rel="preload" href="/_next/static/chunks/zzz.js" as="script"/>
<style data-emotion="css">.x-9{margin:0}</style>
<script>self.__NEXT_DATA__={"buildId":"def","tokens":{"a":2}}</script>
</head><body>
<!--$-->
${article}
<!--/$-->
<script src="/_next/static/chunks/ccc-${Math.random()}.js"></script>
</body></html>`;

    const filteredA = stripVolatileMarkup(renderA);
    const filteredB = stripVolatileMarkup(renderB);

    expect(filteredA).toBe(filteredB);
    expect(await sha256(filteredA)).toBe(await sha256(filteredB));
  });

  it("treats real content changes as a hash difference (no over-filtering)", async () => {
    const before = `<article><h2>v1.0</h2><p>Initial release.</p></article>`;
    const after = `<article><h2>v1.1</h2><p>Bug fixes.</p></article>`;

    expect(await sha256(stripVolatileMarkup(before))).not.toBe(
      await sha256(stripVolatileMarkup(after)),
    );
  });
});
