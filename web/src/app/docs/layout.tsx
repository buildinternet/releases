import { Header } from "@/components/header";
import { DocsNav, type DocsNavSection } from "@/components/docs-nav";
import { DocsToc } from "@/components/docs-toc";
import { adminDocs } from "@/flags";
import { docsManifest, groupBySection } from "@/lib/docs-manifest";

function navSections(): DocsNavSection[] {
  return groupBySection(docsManifest({ includeAdmin: adminDocs })).map(({ section, items }) => ({
    title: section,
    items: items.map((entry) => ({ label: entry.label, href: entry.path })),
  }));
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col md:flex-row gap-6 md:gap-12">
        <DocsNav sections={navSections()} />
        <article className="min-w-0 flex-1 prose prose-stone dark:prose-invert prose-headings:tracking-tight prose-code:before:content-none prose-code:after:content-none prose-code:bg-stone-100 prose-code:dark:bg-stone-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono">
          {children}
        </article>
        <DocsToc />
      </div>
    </div>
  );
}
