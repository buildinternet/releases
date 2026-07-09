import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { Header } from "@/components/header";
import { ProductAdminPanel } from "@/components/product-admin-panel";
import { isAdminViewer } from "@/lib/server-session";
import { ApiNotFoundError, ApiSetupError } from "@/lib/api";
import { getOrg } from "../../_lib/org-data";
import { getResolved } from "../_lib/resolve";
import { getProductById } from "../_lib/product-data";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Product admin settings at `/{org}/{product}/admin`. Sources keep their
 * header dropdown for now — hitting this path on a source slug 404s.
 */
export default async function ProductAdminPage({
  params,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
}) {
  if (!(await isAdminViewer())) notFound();

  const { orgSlug, slug } = await params;

  let resolved;
  try {
    resolved = await getResolved(orgSlug, slug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  if (resolved.kind !== "product") notFound();

  // Single-product orgs collapse the public product page to the org — same
  // rule for admin so we don't maintain a dead URL.
  let org;
  try {
    org = await getOrg(orgSlug);
  } catch {
    notFound();
  }
  if (org.products.length <= 1) {
    permanentRedirect(`/${orgSlug}/admin`);
  }

  const product = await getProductById(resolved.product.id);

  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto max-w-[1000px] px-6 pb-24 pt-5">
        <div className="text-[13px] text-stone-400 dark:text-stone-500">
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <Link href={`/${orgSlug}`} className="hover:text-stone-600 dark:hover:text-stone-300">
            {org.name}
          </Link>
          <span className="mx-1.5">/</span>
          <Link
            href={`/${orgSlug}/${product.slug}`}
            className="hover:text-stone-600 dark:hover:text-stone-300"
          >
            {product.name}
          </Link>
          <span className="mx-1.5">/</span>
          <span className="font-medium text-stone-600 dark:text-stone-300">Admin</span>
        </div>

        <ProductAdminPanel
          orgSlug={orgSlug}
          orgName={org.name}
          productSlug={product.slug}
          name={product.name}
          notice={product.notice}
          sourceCount={product.sources.length}
        />
      </div>
    </div>
  );
}
