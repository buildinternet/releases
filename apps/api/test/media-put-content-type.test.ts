/**
 * `PUT /v1/media/:key` writes into the bucket served as-is from
 * media.releases.sh, so it only stores raster images and video. A document
 * type (HTML, SVG, XML) there would run script on a `releases.sh` subdomain.
 */
import { describe, it, expect } from "bun:test";
import { mediaRoutes } from "../src/routes/media";

const ROOT = "root-secret";

function setup() {
  const puts: Array<{ key: string; contentType?: string }> = [];
  const env = {
    RELEASES_API_KEY: { get: async () => ROOT },
    ENVIRONMENT: "production",
    MEDIA: {
      put: async (
        key: string,
        _body: unknown,
        opts?: { httpMetadata?: { contentType?: string } },
      ) => {
        puts.push({ key, contentType: opts?.httpMetadata?.contentType });
      },
    },
  } as never;
  const put = (contentType: string | null) =>
    mediaRoutes.request(
      "/media/orgs/acme.png",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ROOT}`,
          ...(contentType ? { "Content-Type": contentType } : {}),
        },
        body: new Uint8Array([1, 2, 3]),
      },
      env,
    );
  return { puts, put };
}

describe("PUT /media/:key content types", () => {
  it("stores an allowed raster type", async () => {
    const { puts, put } = setup();
    const res = await put("image/png");
    expect(res.status).toBe(201);
    expect(puts).toEqual([{ key: "orgs/acme.png", contentType: "image/png" }]);
  });

  it("normalizes parameters and case on an allowed type", async () => {
    const { puts, put } = setup();
    const res = await put("Image/WEBP; charset=binary");
    expect(res.status).toBe(201);
    expect(puts[0]?.contentType).toBe("image/webp");
  });

  for (const type of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", null]) {
    it(`refuses ${type ?? "a missing content type"}`, async () => {
      const { puts, put } = setup();
      const res = await put(type);
      expect(res.status).toBe(400);
      expect(puts).toHaveLength(0);
    });
  }

  it("still requires admin auth", async () => {
    const { puts } = setup();
    const res = await mediaRoutes.request(
      "/media/x.png",
      { method: "PUT", headers: { "Content-Type": "image/png" }, body: "x" },
      {
        RELEASES_API_KEY: { get: async () => ROOT },
        ENVIRONMENT: "production",
        MEDIA: {},
      } as never,
    );
    expect(res.status).toBe(401);
    expect(puts).toHaveLength(0);
  });
});
