import { type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { formatErrorResponse } from "@/lib/format-error";
import { productFormatResponse } from "@/lib/format-product";
import { getFormat } from "@/lib/request";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgSlug: string; productSlug: string }> },
) {
  const { orgSlug, productSlug } = await params;
  const format = getFormat(request);

  let product;
  try {
    product = await api.productDetail({ orgSlug, productSlug });
  } catch (err) {
    return formatErrorResponse(err, "Product not found");
  }

  return productFormatResponse(request, orgSlug, product, format);
}
