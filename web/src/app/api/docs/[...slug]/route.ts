import { notFound } from "next/navigation";
import { publicDocs, adminDocs } from "@/flags";
import { loadDoc } from "@/lib/docs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const docsEnabled = await publicDocs();
  if (!docsEnabled) notFound();

  const { slug: slugParts } = await params;
  const slug = slugParts.join("/") || "index";

  let doc;
  try {
    doc = loadDoc(slug);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") notFound();
    throw err;
  }

  if (doc.frontmatter.adminOnly) {
    const showAdmin = await adminDocs();
    if (!showAdmin) notFound();
  }

  return new Response(doc.public, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
}
