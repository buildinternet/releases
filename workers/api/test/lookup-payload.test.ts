import { describe, it, expect } from "bun:test";
import { toLookupPayload } from "../src/routes/search.js";

describe("toLookupPayload thumbnail derivation", () => {
  const origin = "https://media.releases.sh";

  it("derives a thumbnail from a release's first image media", () => {
    const lookup = {
      status: "existing",
      source: null,
      relatedOrg: null,
      releases: [
        {
          id: "rel_1",
          version: "1.0.0",
          title: "Big launch",
          publishedAt: "2026-05-01T00:00:00.000Z",
          media: JSON.stringify([
            { type: "image", url: "https://cdn.example.com/a.png", alt: "Hero" },
          ]),
        },
      ],
    } as unknown as Parameters<typeof toLookupPayload>[0];

    const out = toLookupPayload(lookup, origin);
    expect(out?.releases?.[0]?.thumbnail).toEqual({
      url: "https://cdn.example.com/a.png",
      alt: "Hero",
    });
  });

  it("yields null thumbnail when the release has no image media", () => {
    const lookup = {
      status: "existing",
      source: null,
      relatedOrg: null,
      releases: [{ id: "rel_2", version: null, title: "No media", publishedAt: null, media: "[]" }],
    } as unknown as Parameters<typeof toLookupPayload>[0];

    expect(toLookupPayload(lookup, origin)?.releases?.[0]?.thumbnail).toBeNull();
  });

  it("returns null for a null lookup", () => {
    expect(toLookupPayload(null, origin)).toBeNull();
  });
});
