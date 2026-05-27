import type { Metadata } from "next";
import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import { api, ApiSetupError, ApiNotFoundError, type ProductDetail } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { getOrg } from "../../_lib/org-data";
import { ProductView } from "../../[slug]/_views/product-view";

const getProduct = cache((orgSlug: string, productSlug: string) =>
  api.productDetail({ orgSlug, productSlug }),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug, productSlug } = await params;
  try {
    const product = await getProduct(orgSlug, productSlug);
    return {
      title: `${product.name} Release Notes & Changelog`,
      description:
        product.description ?? `Release notes, changelog, and updates for ${product.name}.`,
      openGraph: { type: "website", url: `/${orgSlug}/product/${productSlug}` },
      alternates: { canonical: `/${orgSlug}/product/${productSlug}` },
    };
  } catch {
    return { title: productSlug };
  }
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}) {
  const { orgSlug, productSlug } = await params;

  let product: ProductDetail;
  let org;
  try {
    [product, org] = await Promise.all([getProduct(orgSlug, productSlug), getOrg(orgSlug)]);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  // Single-product collapse: with ≤1 product the org page is already this
  // product's feed, so the product page would be duplicate content. 301 home.
  if (org.products.length <= 1) {
    permanentRedirect(`/${orgSlug}`);
  }

  return <ProductView orgSlug={orgSlug} orgName={org.name} product={product} />;
}
