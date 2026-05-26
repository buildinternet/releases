import { describe, expect, test } from "bun:test";
import { normalizeMediaUrl } from "./media-url.js";

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
});
