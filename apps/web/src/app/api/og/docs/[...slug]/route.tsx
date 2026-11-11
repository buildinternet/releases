import { adminDocs } from "@/flags";
import { docsManifest, findLoadedDoc } from "@/lib/docs-manifest";
import { renderOgImage } from "@/lib/og";

/**
 * Per-page docs OG cards, driven by `og` frontmatter in the page's `.mdx`
 * (`/api/og/docs/index` is the `/docs` root). Pages without `og` use the
 * shared `/api/og/site` card and 404 here. Content is static, so each card is
 * rendered once at build time.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return docsManifest({ includeAdmin: adminDocs })
    .filter((entry) => findLoadedDoc(entry.slug)?.frontmatter.og)
    .map((entry) => ({ slug: entry.slug.split("/") }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const og = findLoadedDoc(slug.join("/"))?.frontmatter.og;
  if (!og) return new Response("Not found", { status: 404 });
  const { alt: _alt, ...card } = og;
  return renderOgImage(card);
}
