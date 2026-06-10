import { describe, it, expect } from "bun:test";
import { NextRequest } from "next/server";
import { markdownResponse } from "./markdown-response.js";
import { jsonFormatResponse } from "./json-response.js";
import { atomResponse } from "./atom-response.js";

// Search Console flagged the `.atom`/`.json`/`.md` format URLs as duplicates of
// their HTML pages. Feeds and raw JSON are machine artifacts → `noindex`;
// markdown is an alternate representation → `rel=canonical` to its HTML twin
// (except `/release/:id`, which has no twin → `noindex`).
describe("format response indexing headers", () => {
  describe("markdownResponse", () => {
    it("emits a canonical Link header to the HTML twin, with no noindex", () => {
      const res = markdownResponse("# hi", {
        cache: "dynamic",
        canonical: "https://releases.sh/vercel/nextjs",
      });
      expect(res.headers.get("Link")).toBe('<https://releases.sh/vercel/nextjs>; rel="canonical"');
      expect(res.headers.get("X-Robots-Tag")).toBeNull();
      expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    });

    it("emits noindex (and no Link) when there is no canonical twin", () => {
      const res = markdownResponse("# hi", { cache: "dynamic", noindex: true });
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(res.headers.get("Link")).toBeNull();
    });

    it("sets neither header when given only a cache policy", () => {
      const res = markdownResponse("# hi", { cache: "static" });
      expect(res.headers.get("X-Robots-Tag")).toBeNull();
      expect(res.headers.get("Link")).toBeNull();
    });
  });

  describe("jsonFormatResponse", () => {
    it("marks the JSON payload noindex and preserves the body", async () => {
      const res = jsonFormatResponse({ ok: true });
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(await res.json()).toEqual({ ok: true });
    });

    it("preserves a passed-through status code", () => {
      const res = jsonFormatResponse({ error: "nope" }, { status: 404 });
      expect(res.status).toBe(404);
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    });
  });

  describe("atomResponse", () => {
    it("marks the feed noindex on the 200 response", () => {
      const req = new NextRequest("https://releases.sh/vercel/nextjs.atom");
      const res = atomResponse(req, "<feed/>", { lastModified: null });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(res.headers.get("Content-Type")).toBe("application/atom+xml; charset=utf-8");
    });

    it("keeps the noindex directive on a 304 revalidation", () => {
      const body = "<feed/>";
      // Prime the etag the way the helper computes it, then send it back as
      // If-None-Match to force the 304 branch.
      const warm = atomResponse(new NextRequest("https://releases.sh/x.atom"), body, {
        lastModified: null,
      });
      const etag = warm.headers.get("ETag") ?? "";
      const req = new NextRequest("https://releases.sh/x.atom", {
        headers: { "if-none-match": etag },
      });
      const res = atomResponse(req, body, { lastModified: null });
      expect(res.status).toBe(304);
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    });
  });
});
