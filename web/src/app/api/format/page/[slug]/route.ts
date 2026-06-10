import { type NextRequest } from "next/server";
import { notFound } from "next/navigation";
import { getBaseUrl } from "@/lib/base-url";
import { loadPage } from "@/lib/docs";
import { STATIC_PAGES } from "@/lib/route-map";
import { markdownResponse } from "@/lib/markdown-response";

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!STATIC_PAGES.has(slug)) notFound();
  let doc;
  try {
    doc = loadPage(slug);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") notFound();
    throw err;
  }
  return markdownResponse(doc.public, {
    cache: "static",
    canonical: `${getBaseUrl(req)}/${slug}`,
  });
}
