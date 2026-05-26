import { describe, expect, test } from "bun:test";
import { parseReleaseMedia } from "./utils.js";

const ORIGIN = "https://media.releases.sh";

describe("parseReleaseMedia — image-proxy unwrapping", () => {
  test("unwraps a root _next/image optimizer URL to the underlying origin asset", () => {
    const raw = JSON.stringify([
      {
        type: "image",
        url: "https://www.granola.ai/_next/image?url=%2FblogImages%2Fbrief-launch.png&w=256&q=75",
        alt: "Brief launch",
      },
    ]);
    const [m] = parseReleaseMedia(raw, ORIGIN);
    expect(m.url).toBe("https://www.granola.ai/blogImages/brief-launch.png");
  });

  test("unwraps a basePath-doubled /updates/_next/image URL (the Granola bug) to the origin asset, not the 404ing /updates path", () => {
    // Granola's extract-path ingest stored the optimizer URL nested under the
    // page path (`/updates/_next/image?...`), which 404s off-origin. The
    // underlying asset lives at the site root.
    const raw = JSON.stringify([
      {
        type: "image",
        url: "https://www.granola.ai/updates/_next/image?url=%2FblogImages%2Fbrief-launch.png&w=256&q=75",
        alt: "Brief launch",
      },
    ]);
    const [m] = parseReleaseMedia(raw, ORIGIN);
    expect(m.url).toBe("https://www.granola.ai/blogImages/brief-launch.png");
  });

  test("leaves a plain absolute media URL unchanged", () => {
    const url = "https://cdn.example.com/img/feature.png";
    const [m] = parseReleaseMedia(JSON.stringify([{ type: "image", url, alt: "x" }]), ORIGIN);
    expect(m.url).toBe(url);
  });

  test("still resolves r2Key into r2Url", () => {
    const raw = JSON.stringify([
      { type: "image", url: "https://x/y.png", r2Key: "releases/abc.png" },
    ]);
    const [m] = parseReleaseMedia(raw, ORIGIN);
    expect(m.r2Url).toBe("https://media.releases.sh/releases/abc.png");
  });

  test("malformed JSON collapses to an empty list", () => {
    expect(parseReleaseMedia("{not json", ORIGIN)).toEqual([]);
  });

  test("non-array JSON collapses to an empty list", () => {
    expect(parseReleaseMedia('{"url":"x"}', ORIGIN)).toEqual([]);
  });
});
