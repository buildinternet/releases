import Link from "next/link";
import type { OrgDetail } from "@/lib/api";
import { productPath } from "@/lib/links";
import { ChevronRightIcon } from "./icons";

/**
 * Releases-tab "By product" entry points: an active "All releases" chip plus a
 * link to each product's own page. Rendered only when an org tracks 2+ products
 * (a single-product picker is noise). Server component.
 */
export function OrgReleaseProductLinks({
  orgSlug,
  products,
}: {
  orgSlug: string;
  products: OrgDetail["products"];
}) {
  if (products.length < 2) return null;

  return (
    <div className="mb-1 mt-3.5 flex flex-wrap items-center gap-2">
      <span className="inline-flex h-[30px] items-center rounded-lg bg-[var(--accent-soft)] px-3 text-[12.5px] font-semibold text-[var(--fg)]">
        All releases
      </span>
      <span className="mx-0.5 h-[18px] w-px bg-[var(--line)]" aria-hidden />
      <span className="mr-px font-mono text-[10.5px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
        By product
      </span>
      {products.map((p) => (
        <Link
          key={p.slug}
          href={productPath(orgSlug, p.slug)}
          title={`Open ${p.name} release notes`}
          className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-[11px] text-[12.5px] text-[var(--fg-2)] transition-colors hover:border-[var(--line-2)] hover:text-[var(--fg)]"
        >
          {p.name}
          <ChevronRightIcon className="h-[13px] w-[13px] text-[var(--fg-3)]" />
        </Link>
      ))}
    </div>
  );
}
