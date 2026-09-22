import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MarketingClassifierState } from "@buildinternet/releases-api-types";
import { ClassifierForm, type ClassifierActions } from "./classifier-form.tsx";

const baseState: MarketingClassifierState = {
  threshold: 0.65,
  defaultThreshold: 0.65,
  updatedAt: null,
  sources: [],
};

// Plain fakes — the component takes its server-action seam via props so this
// test never imports the "use server" module (which pulls in `server-only`
// and throws outside a request context).
const noopActions: ClassifierActions = {
  getState: async () => null,
  setThreshold: async () => ({ ok: true, data: baseState }),
  setSourceFilter: async () => ({ ok: true }),
};

describe("ClassifierForm", () => {
  it("shows the threshold, default, and an empty-sources message", () => {
    const html = renderToStaticMarkup(<ClassifierForm initial={baseState} actions={noopActions} />);
    expect(html).toContain("Suppression threshold");
    expect(html).toContain("0.65");
    expect(html).toContain("No sources have the filter on.");
    expect(html).toContain("no operator override stored");
  });

  it("lists filtered sources with their org, type, and hint", () => {
    const state: MarketingClassifierState = {
      ...baseState,
      threshold: 0.72,
      updatedAt: "2026-09-20T00:00:00.000Z",
      sources: [
        {
          id: "src_1",
          slug: "acme-blog",
          name: "Acme Blog",
          type: "scrape",
          orgSlug: "acme",
          hint: "Watch for x",
          recentReleaseCount: 4,
        },
      ],
    };
    const html = renderToStaticMarkup(<ClassifierForm initial={state} actions={noopActions} />);
    expect(html).toContain("Acme Blog");
    expect(html).toContain("acme/acme-blog");
    expect(html).toContain("Watch for x");
    expect(html).toContain("0.72");
    expect(html).not.toContain("No sources have the filter on.");
  });

  it("lets an operator turn the filter on for another source by id", () => {
    const html = renderToStaticMarkup(<ClassifierForm initial={baseState} actions={noopActions} />);
    expect(html).toContain("src_… to turn the filter on");
    expect(html).toContain("Turn on");
  });
});
