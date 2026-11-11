import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminDocs } from "@/flags";
import { CopyPageButton } from "@/components/copy-page-button";
import { docsMdxComponents } from "@/components/docs/mdx-components";
import { docPageMetadata } from "@/lib/doc-metadata";
import { docMarkdown } from "@/lib/docs";
import { docsManifest, findVisibleDoc } from "@/lib/docs-manifest";
import { source } from "@/lib/source";

/**
 * Every `/docs` page. Content is `src/content/docs/**\/*.mdx`; sidebar order is
 * `src/content/docs/meta.json`. Adding a page = adding an `.mdx` file and
 * listing it in meta.json.
 *
 * Listed pages are prerendered. Any other `/docs/*` path still lands here (not
 * on the `[orgSlug]` routes) and gets a 404 from `notFound()` below.
 */
type Props = { params: Promise<{ slug?: string[] }> };

export function generateStaticParams() {
  return docsManifest({ includeAdmin: adminDocs }).map((entry) => ({
    slug: entry.slug === "index" ? [] : entry.slug.split("/"),
  }));
}

/** The listed, visible doc for a URL (`index` for `/docs`), if any. */
function resolveDoc(parts: string[] | undefined) {
  return findVisibleDoc(parts?.length ? parts.join("/") : "index", { includeAdmin: adminDocs });
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = resolveDoc((await params).slug);
  return doc ? docPageMetadata(doc.slug, doc.frontmatter) : {};
}

export default async function DocPage({ params }: Props) {
  const { slug: parts } = await params;
  const doc = resolveDoc(parts);
  const page = doc && source.getPage(parts ?? []);
  if (!doc || !page) notFound();

  const Body = page.data.body;
  return (
    <>
      <div className="not-prose mb-8 flex justify-end">
        <CopyPageButton markdown={docMarkdown(doc, { includeAdmin: adminDocs })} slug={doc.slug} />
      </div>
      <Body components={docsMdxComponents} />
    </>
  );
}
