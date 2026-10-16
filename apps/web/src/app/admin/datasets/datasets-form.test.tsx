import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminDatasetSource, AdminDatasetsResponse } from "@buildinternet/releases-api-types";
import { DatasetsForm, type DatasetActions } from "./datasets-form";

const source: AdminDatasetSource = {
  id: "src_example",
  slug: "changelog",
  name: "Example changelog",
  orgSlug: "example",
  orgName: "Example",
  defaultEnabled: true,
  settings: null,
  effective: {
    name: "Example release dataset",
    description: "A complete collection of Example product announcements and release notes.",
  },
  blockedReasons: [],
};

function render(sources: AdminDatasetSource[], page = 1, hasMore = false) {
  const initial: AdminDatasetsResponse = {
    sources,
    pagination: { page, limit: 20, hasMore },
    query: "example",
  };
  const actions: DatasetActions = {
    getSources: async () => ({ ok: true, data: initial }),
    saveSource: async () => ({ ok: true, data: null }),
  };
  return renderToStaticMarkup(<DatasetsForm initial={initial} actions={actions} />);
}

describe("dataset operator forms", () => {
  it("keeps an explicit disabled override selected even when the source defaults on", () => {
    const html = render([{ ...source, settings: { enabled: false }, effective: null }]);
    expect(html).toContain('<option value="disabled" selected="">Disabled</option>');
    expect(html).toContain("Not selected");
    expect(html).toContain("No public dataset");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save dataset<\/button>/);
    const reset = html.match(/<button[^>]*>Reset to default<\/button>/)?.[0];
    expect(reset).toBeDefined();
    expect(reset).not.toContain('disabled=""');
  });

  it("does not offer a save for unchanged copy overrides regardless of stored field order", () => {
    const html = render([{ ...source, settings: { name: "Custom dataset", enabled: true } }]);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save dataset<\/button>/);
  });

  it("shows effective copy separately from inherited fields and reports eligibility blocks", () => {
    const html = render([source]);
    const blockedHtml = render([
      {
        ...source,
        id: "src_blocked",
        settings: { enabled: true, name: "Custom dataset" },
        blockedReasons: ["Source is hidden", "Organization is deleted"],
      },
    ]);
    expect(html).toContain("Example release dataset");
    expect(html).toContain('<option value="default" selected="">Default (enabled)</option>');
    expect(html).toMatch(/id="src_example-name"[^>]*value=""/);
    expect(html).toMatch(/id="src_example-description"[^>]*><\/textarea>/);
    expect(blockedHtml).toContain('value="Custom dataset"');
    expect(blockedHtml).toContain("Blocked: Source is hidden · Organization is deleted");
    expect(blockedHtml).toContain("Public indexing blocked");
    expect(blockedHtml).not.toContain("Public dataset active");
    expect(blockedHtml).toContain('for="src_blocked-mode"');
    expect(blockedHtml).toContain('aria-describedby="src_blocked-copy-help"');
  });

  it.each([
    [1, true, true, false],
    [2, false, false, true],
  ])("shows pagination boundaries on page %i", (page, more, previousDisabled, nextDisabled) => {
    const html = render([], page, more);
    expect(html).toContain('for="dataset-search"');
    expect(html).toContain('value="example"');
    expect(html).toContain("No sources match this search.");
    expect(html).toContain(`Page ${page}`);
    const previous = html.match(/<button[^>]*>Previous<\/button>/)?.[0];
    const next = html.match(/<button[^>]*>Next<\/button>/)?.[0];
    expect(previous).toBeDefined();
    expect(next).toBeDefined();
    expect(previous?.includes('disabled=""')).toBe(previousDisabled);
    expect(next?.includes('disabled=""')).toBe(nextDisabled);
  });
});
