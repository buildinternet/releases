import { describe, expect, test } from "bun:test";
import { normalizeMediaUrl, cfImageUrl, cfMediaUrl } from "./media-url.js";

describe("cfImageUrl", () => {
  const origin = "https://media.releases.sh";

  test("wraps an absolute raster image URL in a Cloudflare width transform", () => {
    expect(cfImageUrl("https://cdn.example.com/a.png", { origin, width: 240 })).toBe(
      "https://media.releases.sh/cdn-cgi/image/width=240,quality=80,format=auto/https://cdn.example.com/a.png",
    );
  });

  test("reflects the requested width", () => {
    expect(cfImageUrl("https://cdn.example.com/a.jpg", { origin, width: 800 })).toBe(
      "https://media.releases.sh/cdn-cgi/image/width=800,quality=80,format=auto/https://cdn.example.com/a.jpg",
    );
  });

  test("appends the source URL raw, preserving its query string", () => {
    expect(cfImageUrl("https://cdn.example.com/a.png?v=2&x=y", { origin, width: 240 })).toBe(
      "https://media.releases.sh/cdn-cgi/image/width=240,quality=80,format=auto/https://cdn.example.com/a.png?v=2&x=y",
    );
  });

  test("transforms an extension-less image URL (caller vouches it is an image)", () => {
    expect(cfImageUrl("https://cdn.example.com/abc123", { origin, width: 240 })).toBe(
      "https://media.releases.sh/cdn-cgi/image/width=240,quality=80,format=auto/https://cdn.example.com/abc123",
    );
  });

  test("strips a trailing slash on origin so the path is not doubled", () => {
    expect(cfImageUrl("https://cdn.example.com/a.png", { origin: `${origin}/`, width: 240 })).toBe(
      "https://media.releases.sh/cdn-cgi/image/width=240,quality=80,format=auto/https://cdn.example.com/a.png",
    );
  });

  test("leaves SVG sources unchanged (vector — nothing to downscale)", () => {
    const svg = "https://cdn.example.com/logo.svg";
    expect(cfImageUrl(svg, { origin, width: 240 })).toBe(svg);
  });

  test("leaves SVG sources with a query string unchanged", () => {
    const svg = "https://cdn.example.com/logo.svg?cache=1";
    expect(cfImageUrl(svg, { origin, width: 240 })).toBe(svg);
  });

  test("leaves a relative URL unchanged (no absolute source to fetch)", () => {
    expect(cfImageUrl("/local/a.png", { origin, width: 240 })).toBe("/local/a.png");
  });

  test("leaves a data: URL unchanged", () => {
    const data = "data:image/png;base64,AAAA";
    expect(cfImageUrl(data, { origin, width: 240 })).toBe(data);
  });

  test("does not double-wrap an already-transformed URL", () => {
    const already =
      "https://media.releases.sh/cdn-cgi/image/width=240,quality=80,format=auto/https://cdn.example.com/a.png";
    expect(cfImageUrl(already, { origin, width: 240 })).toBe(already);
  });

  test("leaves a non-parseable string unchanged", () => {
    expect(cfImageUrl("not a url", { origin, width: 240 })).toBe("not a url");
  });

  test("returns the source unchanged when origin is empty", () => {
    expect(cfImageUrl("https://cdn.example.com/a.png", { origin: "", width: 240 })).toBe(
      "https://cdn.example.com/a.png",
    );
  });
});

describe("cfMediaUrl", () => {
  const origin = "https://media.releases.sh";

  test("wraps an absolute GIF URL in a Media Transformations video transform", () => {
    expect(cfMediaUrl("https://cdn.example.com/demo.gif", { origin })).toBe(
      "https://media.releases.sh/cdn-cgi/media/mode=video/https://cdn.example.com/demo.gif",
    );
  });

  test("appends the source raw, preserving its path and query", () => {
    const src =
      "https://media.beehiiv.com/cdn-cgi/image/format=auto,onerror=redirect/uploads/x/subscribe_forms-2.gif";
    expect(cfMediaUrl(src, { origin })).toBe(`${origin}/cdn-cgi/media/mode=video/${src}`);
  });

  test("strips a trailing slash on origin so the path is not doubled", () => {
    expect(cfMediaUrl("https://cdn.example.com/a.gif", { origin: `${origin}/` })).toBe(
      "https://media.releases.sh/cdn-cgi/media/mode=video/https://cdn.example.com/a.gif",
    );
  });

  test("does not double-wrap an already-transformed media URL", () => {
    const already =
      "https://media.releases.sh/cdn-cgi/media/mode=video/https://cdn.example.com/a.gif";
    expect(cfMediaUrl(already, { origin })).toBe(already);
  });

  test("leaves a relative URL unchanged (no absolute source to fetch)", () => {
    expect(cfMediaUrl("/local/a.gif", { origin })).toBe("/local/a.gif");
  });

  test("leaves a data: URL unchanged", () => {
    const data = "data:image/gif;base64,R0lGODlh";
    expect(cfMediaUrl(data, { origin })).toBe(data);
  });

  test("leaves a non-parseable string unchanged", () => {
    expect(cfMediaUrl("not a url", { origin })).toBe("not a url");
  });

  test("returns the source unchanged when origin is empty", () => {
    expect(cfMediaUrl("https://cdn.example.com/a.gif", { origin: "" })).toBe(
      "https://cdn.example.com/a.gif",
    );
  });
});

describe("normalizeMediaUrl", () => {
  test("unwraps a root _next/image optimizer URL to the underlying origin asset", () => {
    expect(
      normalizeMediaUrl(
        "https://www.granola.ai/_next/image?url=%2FblogImages%2Fbrief-launch.png&w=256&q=75",
      ),
    ).toBe("https://www.granola.ai/blogImages/brief-launch.png");
  });

  test("unwraps a basePath-doubled /updates/_next/image URL to the origin asset", () => {
    expect(
      normalizeMediaUrl(
        "https://www.granola.ai/updates/_next/image?url=%2FblogImages%2Fbrief-launch.png&w=256&q=75",
      ),
    ).toBe("https://www.granola.ai/blogImages/brief-launch.png");
  });

  test("preserves an absolute inner url (off-origin CDN)", () => {
    expect(
      normalizeMediaUrl(
        "https://vercel.com/changelog/x/_next/image?url=https%3A%2F%2Fassets.vercel.com%2Fimage%2Fa.png&w=1080&q=75",
      ),
    ).toBe("https://assets.vercel.com/image/a.png");
  });

  test("unwraps a _vercel/image optimizer URL", () => {
    expect(normalizeMediaUrl("https://example.com/_vercel/image?url=%2Fhero.png&w=640&q=80")).toBe(
      "https://example.com/hero.png",
    );
  });

  test("recovers the inner asset when the proxy marker landed in the query string (mangled ingest)", () => {
    // Source URL carried its own query (`/blog?category=changelog`); a relative
    // `_next/image?url=…` got concatenated onto it, so the optimizer path ends
    // up in the query string and `pathname` is just `/blog`. The inner asset is
    // still recoverable from the proxy marker's `url=` param.
    expect(
      normalizeMediaUrl(
        "https://lightfield.app/blog?category=changelog/_next/image?url=https%3A%2F%2Fcdn.sanity.io%2Fimages%2Fp%2Fcover.png&w=5120&q=90",
      ),
    ).toBe("https://cdn.sanity.io/images/p/cover.png");
  });

  test("leaves a plain absolute (non-proxy) URL unchanged", () => {
    const url = "https://cdn.example.com/img/feature.png";
    expect(normalizeMediaUrl(url)).toBe(url);
  });

  test("returns a malformed (non-parseable) URL unchanged", () => {
    expect(normalizeMediaUrl("not a url")).toBe("not a url");
  });

  // #1943 — AI-extracted x.ai media had every path `/` replaced by `0.000000`
  // (printf %f / float-zero). Repair reconstructs the real asset path.
  test("repairs float-zero path separators (x.ai media corruption)", () => {
    expect(
      normalizeMediaUrl("https://x.ai/0.000000images0.000000news0.000000composer-2-5-og.png"),
    ).toBe("https://x.ai/images/news/composer-2-5-og.png");
  });

  test("repairs float-zero path separators with multi-segment nested paths", () => {
    expect(
      normalizeMediaUrl("https://x.ai/0.000000images0.000000grok-office0.000000grok-ppt.webp"),
    ).toBe("https://x.ai/images/grok-office/grok-ppt.webp");
  });

  test("leaves 0.000000 in query strings alone (not path corruption)", () => {
    const url = "https://cdn.example.com/img.png?scale=0.000000&w=100";
    expect(normalizeMediaUrl(url)).toBe(url);
  });

  test("float-zero repair is idempotent on already-correct paths", () => {
    const url = "https://x.ai/images/news/composer-2-5-og.png";
    expect(normalizeMediaUrl(url)).toBe(url);
  });
});
