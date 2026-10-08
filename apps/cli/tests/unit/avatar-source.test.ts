import { describe, it, expect } from "bun:test";
import {
  githubAvatarUrl,
  faviconAvatarUrl,
  appStoreTrackId,
  upscaleArtwork,
  appStoreArtworkUrl,
} from "../../src/lib/avatar-source.js";

describe("githubAvatarUrl", () => {
  it("builds the per-account avatar redirect, stripping a leading @", () => {
    expect(githubAvatarUrl("vercel")).toBe("https://github.com/vercel.png");
    expect(githubAvatarUrl("@stripe")).toBe("https://github.com/stripe.png");
  });
});

describe("faviconAvatarUrl", () => {
  it("builds the apple-touch-icon URL, tolerating protocol/path in the domain", () => {
    expect(faviconAvatarUrl("acme.com")).toBe("https://acme.com/apple-touch-icon.png");
    expect(faviconAvatarUrl("https://acme.com/blog")).toBe("https://acme.com/apple-touch-icon.png");
  });
});

describe("appStoreTrackId", () => {
  it("extracts the numeric id from an apps.apple.com URL", () => {
    expect(appStoreTrackId("https://apps.apple.com/us/app/1password/id1511601750")).toBe(
      "1511601750",
    );
    expect(appStoreTrackId("https://example.com/no-id")).toBeNull();
  });
});

describe("upscaleArtwork", () => {
  it("upscales the NxN size segment to 1024×1024", () => {
    expect(upscaleArtwork("https://is1-ssl.mzstatic.com/image/x/512x512bb.png")).toBe(
      "https://is1-ssl.mzstatic.com/image/x/1024x1024bb.png",
    );
    expect(upscaleArtwork("https://is1-ssl.mzstatic.com/image/x/100x100bb.jpg")).toBe(
      "https://is1-ssl.mzstatic.com/image/x/1024x1024bb.jpg",
    );
  });
  it("leaves an unrecognized URL unchanged (still a valid square ≥128px)", () => {
    expect(upscaleArtwork("https://cdn.example.com/icon.png")).toBe(
      "https://cdn.example.com/icon.png",
    );
  });
});

const fetchOk = (body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as (input: string) => Promise<Response>;

describe("appStoreArtworkUrl", () => {
  it("returns the upscaled 512 artwork from the iTunes lookup", async () => {
    const url = await appStoreArtworkUrl(
      "123",
      fetchOk({ results: [{ artworkUrl512: "https://m.test/512x512bb.png" }] }),
    );
    expect(url).toBe("https://m.test/1024x1024bb.png");
  });

  it("falls back to artworkUrl100 when 512 is absent", async () => {
    const url = await appStoreArtworkUrl(
      "123",
      fetchOk({ results: [{ artworkUrl100: "https://m.test/100x100bb.jpg" }] }),
    );
    expect(url).toBe("https://m.test/1024x1024bb.jpg");
  });

  it("returns null on an empty result set", async () => {
    expect(await appStoreArtworkUrl("123", fetchOk({ results: [] }))).toBeNull();
  });

  it("returns null on a non-OK lookup", async () => {
    const fetchFail = (async () => new Response("nope", { status: 404 })) as unknown as (
      input: string,
    ) => Promise<Response>;
    expect(await appStoreArtworkUrl("123", fetchFail)).toBeNull();
  });
});
