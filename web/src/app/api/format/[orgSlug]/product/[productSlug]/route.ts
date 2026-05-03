import { NextResponse, type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { getBaseUrl } from "@/lib/base-url";
import { productToMarkdown } from "@/lib/formatters";
import { markdownResponse } from "@/lib/markdown-response";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgSlug: string; productSlug: string }> },
) {
  const { orgSlug, productSlug } = await params;
  let product;
  try {
    product = await api.productDetail({ orgSlug, productSlug });
  } catch {
    return NextResponse.json({ error: "not_found", message: "Product not found" }, { status: 404 });
  }
  return markdownResponse(productToMarkdown(product, orgSlug, { baseUrl: getBaseUrl(request) }), {
    cache: "semi-static",
  });
}
