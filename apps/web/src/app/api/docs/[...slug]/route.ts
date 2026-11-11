import { type NextRequest, NextResponse } from "next/server";
import { adminDocs } from "@/flags";
import { getBaseUrl } from "@/lib/base-url";
import { docMarkdown } from "@/lib/docs";
import { findLoadedDoc } from "@/lib/docs-manifest";
import { MARKDOWN_404_BODY } from "@/lib/markdown-404";
import { markdownResponse } from "@/lib/markdown-response";

function notFoundMarkdown(): NextResponse {
  return new NextResponse(MARKDOWN_404_BODY, {
    status: 404,
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug: slugParts } = await params;
  const slug = slugParts.join("/") || "index";

  // Only pages listed in meta.json are served (the same set the HTML route builds).
  const doc = findLoadedDoc(slug);
  if (!doc) return notFoundMarkdown();
  if (doc.frontmatter.adminOnly && !adminDocs) return notFoundMarkdown();

  const canonicalPath = slug === "index" ? "/docs" : `/docs/${slug}`;
  return markdownResponse(docMarkdown(doc, { includeAdmin: adminDocs }), {
    cache: "semi-static",
    canonical: `${getBaseUrl(req)}${canonicalPath}`,
  });
}
