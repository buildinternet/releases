import { DocsNav, type DocsNavSection } from "@/components/docs-nav";
import { adminDocs } from "@/flags";
import { API_REFERENCE_SLUG, apiReferenceEntries, docsManifest } from "@/lib/docs-manifest";

/**
 * The API reference area (`/docs/api/reference/**`): its own sidebar (an
 * overview plus endpoints grouped by area) and a wider content column with no
 * "On this page" rail, so the endpoint panels get the room. Pages are
 * generated from the OpenAPI spec; see `scripts/generate-openapi-docs.ts`.
 */
function navSections(): DocsNavSection[] {
  const entries = apiReferenceEntries(docsManifest({ includeAdmin: adminDocs }));
  return [
    {
      title: "API Reference",
      items: entries.map((entry) => ({
        label: entry.slug === API_REFERENCE_SLUG ? "Overview" : entry.label,
        href: entry.path,
        group: entry.navGroup,
        method: entry.apiMethod,
      })),
    },
  ];
}

export default function ApiReferenceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-[90rem] px-6 py-10 flex flex-col md:flex-row gap-6 md:gap-12">
        <DocsNav
          sections={navSections()}
          backLink={{ label: "Docs", href: "/docs" }}
          widthClassName="w-[230px]"
        />
        <article className="pixel-doc-title min-w-0 flex-1 max-w-none prose prose-stone dark:prose-invert prose-headings:tracking-tight prose-code:before:content-none prose-code:after:content-none prose-code:bg-stone-100 prose-code:dark:bg-stone-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono">
          {children}
        </article>
      </div>
    </div>
  );
}
