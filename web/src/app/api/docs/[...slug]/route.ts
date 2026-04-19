import { notFound } from "next/navigation";
import matter from "gray-matter";
import { adminDocs } from "@/flags";
import { loadDoc, stripAdminBlocks, keepAdminBlocks } from "@/lib/docs";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
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

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
}
