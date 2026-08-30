import { type NextRequest, NextResponse } from "next/server";
import matter from "gray-matter";
import { adminDocs } from "@/flags";
import { getBaseUrl } from "@/lib/base-url";
import { loadDoc, stripAdminBlocks, keepAdminBlocks } from "@/lib/docs";
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

  let doc;
  try {
    doc = loadDoc(slug);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return notFoundMarkdown();
    throw err;
  }

  const showAdmin = adminDocs;
  if (doc.frontmatter.adminOnly && !showAdmin) return notFoundMarkdown();

  const parsed = matter(doc.public);
  const transformed = showAdmin
    ? keepAdminBlocks(parsed.content)
    : stripAdminBlocks(parsed.content);
  const body = matter.stringify(transformed.trimStart(), parsed.data);

  const canonicalPath = slug === "index" ? "/docs" : `/docs/${slug}`;
  return markdownResponse(body, {
    cache: "semi-static",
    canonical: `${getBaseUrl(req)}${canonicalPath}`,
  });
}
