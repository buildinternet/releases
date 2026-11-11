import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminDocs } from "@/flags";
import { CopyPageButton } from "@/components/copy-page-button";
import { docsMdxComponents } from "@/components/docs/mdx-components";
import { docPageMetadata } from "@/lib/doc-metadata";
import { docMarkdown } from "@/lib/docs";
import { docsManifest, findLoadedDoc } from "@/lib/docs-manifest";
import { source } from "@/lib/source";

/**
 * Every `/docs` page. Content is `src/content/docs/**\/*.mdx`; sidebar order is
 * `src/content/docs/meta.json`. Adding a page = adding an `.mdx` file and
 * listing it in meta.json.
 */
type Props = { params: Promise<{ slug?: string[] }> };

// Listed pages are prerendered. Any other `/docs/*` path still lands here (not
// on the `[orgSlug]` routes) and gets a 404 from `notFound()` below.

export function generateStaticParams() {
  return docsManifest({ includeAdmin: adminDocs }).map((entry) => ({
    slug: entry.slug === "index" ? [] : entry.slug.split("/"),
  }));
}

/** Resolve a URL to a listed, visible docs slug (`index` for `/docs`), or `null`. */
function resolveSlug(parts: string[] | undefined): string | null {
  const slug = parts?.length ? parts.join("/") : "index";
  const doc = findLoadedDoc(slug);
  if (!doc || (doc.frontmatter.adminOnly && !adminDocs)) return null;
  return slug;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = resolveSlug((await params).slug);
  return slug ? docPageMetadata(slug) : {};
}

export default async function DocPage({ params }: Props) {
  const { slug: parts } = await params;
  const slug = resolveSlug(parts);
  const page = slug ? source.getPage(parts ?? []) : undefined;
  if (!slug || !page) notFound();

  const Body = page.data.body;
  return (
    <>
      <div className="not-prose mb-8 flex justify-end">
        <CopyPageButton
          markdown={docMarkdown(findLoadedDoc(slug)!, { includeAdmin: adminDocs })}
          slug={slug}
        />
      </div>
      <Body components={docsMdxComponents} />
    </>
  );
}
