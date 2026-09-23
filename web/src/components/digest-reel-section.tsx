"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { OrgAvatar } from "./org-avatar";
import { ExternalArrow } from "./digest-icons";
import { isExternalReleaseLink, releaseLinkProps } from "@/lib/release-link";
import { digestHref, HOVER_RELEASES, type ReelCard, type ReelCardSection } from "@/lib/digest-reel";

/** Products shown in the hover card's single-line row before the "+N" chip. */
const HOVER_PRODUCTS = 3;

/** True when the currently focused element is inside `container` — used to
 *  decide whether closing the hover card should hand focus back to the row
 *  link (Escape, or a mouse-leave that unmounts the card while focus is
 *  inside it) rather than letting focus silently fall through to `<body>`.
 *  A tiny pure predicate so it's testable without a real DOM/hover session. */
export function focusIsInside(
  container: { contains(node: Node | null): boolean } | null,
  active: Node | null,
): boolean {
  return !!container && !!active && container.contains(active);
}

/** One entry per org, first-seen order — a row's avatar stack. Products from
 *  the same org share its logo, so repeating it adds nothing. */
export function distinctOrgProducts<T extends { org: { slug: string } }>(
  products: readonly T[],
): T[] {
  const seen = new Set<string>();
  return products.filter((p) => !seen.has(p.org.slug) && !!seen.add(p.org.slug));
}

/**
 * One "In this issue" row: an internal link to the section's anchor on the
 * digest page (same tab, no ↗). On md+ a hover/focus card previews the
 * products the section covers, its lede, and the first few releases it cites —
 * those release links go upstream via {@link releaseLinkProps}. On touch the
 * row is just the link.
 */
export function DigestSectionRow({
  digest,
  section,
  index,
}: {
  digest: ReelCard;
  section: ReelCardSection;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  const products = section.products;
  const href = digestHref(digest, section.anchor);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // If focus is inside the card when it closes (Escape, or a mouse-leave
  // while a card release link is focused), it would otherwise fall through
  // to `<body>` once the card unmounts — hand it back to the row link.
  const close = () => {
    if (focusIsInside(cardRef.current, document.activeElement)) linkRef.current?.focus();
    setOpen(false);
  };

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={close}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <Link
        ref={linkRef}
        href={href}
        className={`-mx-2 flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800 ${
          open ? "bg-stone-100 dark:bg-stone-800" : ""
        }`}
      >
        <span className="font-mono text-[11px] text-stone-400 dark:text-stone-600">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="min-w-0 flex-1 truncate">{section.heading}</span>
        <span className="flex pr-1" title={products.map((p) => p.name).join(", ")}>
          {distinctOrgProducts(products).map((p) => (
            <span
              key={p.org.slug}
              className="-mr-1 rounded-full ring-[1.5px] ring-white dark:ring-stone-900"
            >
              <OrgAvatar
                avatarUrl={p.org.avatarUrl}
                githubHandle={p.org.githubHandle}
                name={p.name}
                size={14}
              />
            </span>
          ))}
        </span>
      </Link>
      {open && (
        // pb-1.5 bridges the gap so the pointer can travel into the card.
        <div
          ref={cardRef}
          className="absolute bottom-full left-[-14px] z-20 hidden pb-1.5 md:block"
        >
          <DigestSectionPreview digest={digest} section={section} />
        </div>
      )}
    </div>
  );
}

/** The hover card body: products the section covers, its lede, and the first
 *  few releases it cites (upstream links via {@link releaseLinkProps}, ↗ only
 *  when the link leaves the site). Exported for tests; state-free. */
export function DigestSectionPreview({
  digest,
  section,
}: {
  digest: ReelCard;
  section: ReelCardSection;
}) {
  const products = section.products;
  const href = digestHref(digest, section.anchor);
  const total = section.releaseCount;
  const more = total - HOVER_RELEASES;
  const shownProducts = products.slice(0, HOVER_PRODUCTS);
  const extraProducts = products.length - HOVER_PRODUCTS;
  return (
    <div className="flex w-[340px] flex-col gap-2.5 rounded-[10px] border border-stone-200 bg-white px-4 pt-3.5 pb-3 shadow-xl dark:border-stone-700 dark:bg-[#262220] dark:shadow-black/50">
      <div className="flex flex-nowrap items-center gap-x-3 overflow-hidden">
        {shownProducts.map((p) => (
          <span
            key={p.key}
            className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-stone-800 dark:text-stone-200"
          >
            <OrgAvatar
              avatarUrl={p.org.avatarUrl}
              githubHandle={p.org.githubHandle}
              name={p.name}
              size={16}
            />
            {p.name}
          </span>
        ))}
        {extraProducts > 0 && (
          <span className="shrink-0 text-[12px] font-medium text-stone-400 dark:text-stone-500">
            +{extraProducts}
          </span>
        )}
      </div>
      {section.lede && (
        <p className="line-clamp-3 text-[12.5px] leading-normal text-stone-500 dark:text-stone-400">
          {section.lede}
        </p>
      )}
      <div className="flex flex-col gap-0.5 border-t border-stone-200 pt-2 dark:border-stone-700">
        {section.releases.map((r) => {
          const linkProps = releaseLinkProps(r);
          return (
            <a
              key={r.id}
              {...linkProps}
              className="-mx-1.5 flex h-[26px] items-center gap-2 rounded px-1.5 text-[12px] text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              <OrgAvatar
                avatarUrl={r.org.avatarUrl}
                githubHandle={r.org.githubHandle}
                name={r.product?.name ?? r.org.name}
                size={14}
              />
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              {isExternalReleaseLink(linkProps) && (
                <>
                  <ExternalArrow
                    size={11}
                    className="shrink-0 text-stone-400 dark:text-stone-500"
                  />
                  <span className="sr-only"> (opens in new tab)</span>
                </>
              )}
            </a>
          );
        })}
        <div className="mt-0.5 flex items-center justify-between">
          <span className="font-mono text-[10.5px] text-stone-400 dark:text-stone-500">
            {total} {total === 1 ? "release" : "releases"}
            {more > 0 ? ` · +${more} more` : ""}
          </span>
          <Link
            href={href}
            className="text-[12px] font-medium text-[var(--accent)] hover:underline"
          >
            Read the section →
          </Link>
        </div>
      </div>
    </div>
  );
}
