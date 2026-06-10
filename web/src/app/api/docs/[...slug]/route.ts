import { type NextRequest } from "next/server";
import { notFound } from "next/navigation";
import matter from "gray-matter";
import { adminDocs } from "@/flags";
import { getBaseUrl } from "@/lib/base-url";
import { loadDoc, stripAdminBlocks, keepAdminBlocks } from "@/lib/docs";
import { markdownResponse } from "@/lib/markdown-response";

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug: slugParts } = await params;
  const slug = slugParts.join("/") || "index";

  let doc;
  try {
    doc = loadDoc(slug);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") notFound();
    throw err;
  }

  const showAdmin = adminDocs;
  if (doc.frontmatter.adminOnly && !showAdmin) notFound();

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
