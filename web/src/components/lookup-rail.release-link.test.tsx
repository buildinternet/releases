import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LookupResultPayload } from "@/lib/api";
import { LookupRail } from "./lookup-rail.tsx";

const basePayload: LookupResultPayload = {
  status: "existing",
  source: {
    id: "src_1",
    slug: "acme-repo",
    name: "acme/repo",
    url: "https://github.com/acme/repo",
    discovery: "on_demand",
  },
  releases: [
    {
      id: "rel_1",
      version: "1.0.0",
      title: "Acme 1.0",
      publishedAt: "2026-05-01T00:00:00.000Z",
      url: null,
    },
  ],
  relatedOrg: null,
};

describe("LookupRail releases preview — link target (#2330)", () => {
  it("links a release upstream in a new tab when it has a url", () => {
    const payload: LookupResultPayload = {
      ...basePayload,
      releases: [{ ...basePayload.releases![0]!, url: "https://acme.test/releases/1.0" }],
    };
    const html = renderToStaticMarkup(<LookupRail query="acme/repo" payload={payload} />);
    expect(html).toContain('href="https://acme.test/releases/1.0"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('data-release-id="rel_1"');
    expect(html).toContain("opens in new tab");
  });

  it("falls back to the internal /release/<id> page when the release has no url", () => {
    const html = renderToStaticMarkup(<LookupRail query="acme/repo" payload={basePayload} />);
    expect(html).toContain('href="/release/rel_1"');
    expect(html).toContain('data-release-id="rel_1"');
    expect(html).not.toContain("opens in new tab");
  });
});
