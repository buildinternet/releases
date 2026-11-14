import type { Metadata } from "next";
import { adminDocs } from "@/flags";
import { DocPageBody, resolveDoc } from "@/components/docs/doc-page-body";
import { docPageMetadata } from "@/lib/doc-metadata";
import { docsManifest, isApiReferenceSlug } from "@/lib/docs-manifest";

/**
 * Every `/docs` page outside the API reference area (which has its own route
 * and layout under `docs/api/reference/`). Content is
 * `src/content/docs/**\/*.mdx`; sidebar order is `src/content/docs/meta.json`.
 * Adding a page = adding an `.mdx` file and listing it in meta.json.
 *
 * Listed pages are prerendered. Any other `/docs/*` path still lands here (not
 * on the `[orgSlug]` routes) and gets a 404 from `notFound()`.
 */
type Props = { params: Promise<{ slug?: string[] }> };

export function generateStaticParams() {
  return docsManifest({ includeAdmin: adminDocs })
    .filter((entry) => !isApiReferenceSlug(entry.slug))
    .map((entry) => ({ slug: entry.slug === "index" ? [] : entry.slug.split("/") }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = resolveDoc((await params).slug);
  return doc ? docPageMetadata(doc.slug, doc.frontmatter) : {};
}

export default async function DocPage({ params }: Props) {
  return <DocPageBody parts={(await params).slug ?? []} />;
}
