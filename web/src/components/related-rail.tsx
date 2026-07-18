import Link from "next/link";
import { api, type RelatedReleaseItem } from "@/lib/api";
import { formatDate } from "@/lib/formatters";
import { clamp, stripMarkdown } from "@/lib/og-helpers";
import { appRowInfoFromWire } from "@/lib/app-source";
import { ImportanceMarker } from "./importance-marker";
import { AppStoreIcon } from "./app-store-icon";
import { AppPlatformCue } from "./app-platform-cue";

interface RelatedRailProps {
  anchorReleaseId: string | null;
  scope: "org" | "global";
  heading: string;
  /** Drop items in this org from the rendered list. Used on the global rail to
   * avoid overlap with the org-scoped rail stacked above it. */
  excludeOrgSlug?: string | null;
  limit?: number;
}

/** Shared card chrome. */
const CARD_CLASS =
  "flex gap-3 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-3 hover:border-stone-300 dark:hover:border-stone-600 transition-colors h-full";
/** Headline type scale: up to two balanced lines, no hard clip. */
const HEADLINE_CLASS =
  "font-semibold text-[14px] text-stone-900 dark:text-stone-100 line-clamp-2 text-balance";
/** Right-hand release thumbnail — small enough not to outweigh the copy. */
const CARD_IMAGE_CLASS =
  "shrink-0 w-10 h-10 rounded-md object-cover bg-stone-100 dark:bg-stone-800";

/**
 * "Related" rail of semantically similar *releases*. Both flavors are
 * release-only, so every card in both rails shares a single template:
 *   - `scope="org"` — "More from {org}" (same-org neighbors)
 *   - `scope="global"` — "From other products" (neighbors in other orgs)
 *
 * The API returns neighbors already ranked (cosine × recency × content
 * quality) with content-free releases dropped and `excludeOrg` applied, so
 * this component renders that order directly. Renders null when the anchor is
 * missing, the fetch degrades, or nothing survives — so callers can stack both
 * rails and let an empty one collapse.
 */
export async function RelatedRail({
  anchorReleaseId,
  scope,
  heading,
  excludeOrgSlug = null,
  limit = 2,
}: RelatedRailProps) {
  if (!anchorReleaseId) return null;

  const res = await api
    .relatedReleases(anchorReleaseId, scope, limit, excludeOrgSlug)
    .catch((err) => {
      console.error(
        `[related-rail] releases fetch failed scope=${scope} anchor=${anchorReleaseId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    });

  const items = res && !res.degraded ? res.items : [];
  if (items.length === 0) return null;

  return (
    <section className="mt-10 pt-6 border-t border-stone-200 dark:border-stone-800">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400 mb-3">
        {heading}
      </h2>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <ReleaseCard item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Company-first attribution shown on every card so they read identically: the
 * org (company) name, plus the trailing product/source name when it adds
 * something. Falls back to the trailing name alone when the row has no org.
 */
function attributionLine(orgName: string | null, trailingName: string): string {
  if (!orgName) return trailingName;
  if (orgName === trailingName) return orgName;
  return `${orgName} · ${trailingName}`;
}

/**
 * The org avatar shown inline beside the attribution label — small enough to
 * read as a wordmark next to 11px text, not a competing graphic. Square logos
 * keep a hairline radius; `bg` covers the gap while the image lazy-loads.
 */
function OrgAvatar({ url }: { url: string }) {
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={url}
      alt=""
      className="shrink-0 w-4 h-4 rounded-sm object-cover bg-stone-100 dark:bg-stone-800"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  );
}

interface ReleaseCardProps {
  item: RelatedReleaseItem;
}

// Exported for render tests (`related-rail.test.tsx`); the async `RelatedRail`
// wrapper is not directly renderable in a unit test.
export function ReleaseCard({ item }: ReleaseCardProps) {
  const href = `/release/${item.id}`;
  // Prefer the product name over the bare source/feed name when the release's
  // source belongs to a product (e.g. "Vercel · Next.js" rather than the feed).
  const trailingName = item.source.productName ?? item.source.name;
  // Mobile-app releases render a lean card: app icon + name + "iOS/macOS app",
  // no version / body / thumbnail — those carry little meaning for a routine app
  // update. `appStore` is only set for `appstore` sources. #mobile-app-release-cards
  const app = appRowInfoFromWire(item.source.appStore, trailingName);
  if (app) return <AppReleaseCard item={item} href={href} app={app} />;

  // Content-first: lead with the release title and demote the version to the
  // subtitle. Fall back to an AI-cleaned short title only when there's no
  // version to surface there.
  const heading = item.title || item.version || "";
  const showVersion = !!item.version && item.version !== heading;
  const subtitleText = showVersion
    ? item.version
    : item.titleShort?.trim() || item.titleGenerated?.trim() || null;
  const preview = releasePreview(item, subtitleText);
  return (
    // Marker sits outside the card link so the HoverCard trigger isn't nested
    // inside an <a> (same rule as feed cards: flame sibling of title link).
    <div className={`${CARD_CLASS} items-start`}>
      <ImportanceMarker importance={item.importance} className="mt-0.5" />
      <Link href={href} className="flex flex-1 gap-3 min-w-0 h-full">
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <span className={HEADLINE_CLASS}>{heading}</span>
            {item.publishedAt && (
              <span className="text-[11px] text-stone-400 dark:text-stone-500 shrink-0 tabular-nums mt-px">
                {formatDate(item.publishedAt)}
              </span>
            )}
          </div>
          {subtitleText && (
            <div className="text-[12px] text-stone-600 dark:text-stone-400 line-clamp-1 mt-0.5">
              {subtitleText}
            </div>
          )}
          {preview && (
            <p className="text-[12px] text-stone-500 dark:text-stone-400 mt-1 line-clamp-2 text-pretty">
              {preview}
            </p>
          )}
          <div className="flex items-center gap-1.5 text-[11px] text-stone-400 dark:text-stone-500 mt-1 min-w-0">
            {item.source.orgAvatarUrl && <OrgAvatar url={item.source.orgAvatarUrl} />}
            <span className="line-clamp-1">
              {attributionLine(item.source.orgName, trailingName)}
            </span>
          </div>
        </div>
        {item.thumbnail && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={item.thumbnail.url}
            alt={item.thumbnail.alt ?? ""}
            className={CARD_IMAGE_CLASS}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        )}
      </Link>
    </div>
  );
}

/**
 * Lean mobile-app variant of {@link ReleaseCard}: the app icon leads, the app
 * name is the headline, and a muted "iOS/macOS app" cue stands in for the
 * version/body/thumbnail — the date still supplies recency. Attribution drops
 * to the org alone (the headline already is the app/product name).
 * #mobile-app-release-cards
 */
function AppReleaseCard({
  item,
  href,
  app,
}: {
  item: RelatedReleaseItem;
  href: string;
  app: { label: "iOS" | "macOS"; iconUrl: string | null; appName: string };
}) {
  return (
    <div className={`${CARD_CLASS} items-start`}>
      <ImportanceMarker importance={item.importance} className="mt-0.5" />
      <Link href={href} className="flex flex-1 gap-3 min-w-0 h-full items-start">
        <AppStoreIcon iconUrl={app.iconUrl} appName={app.appName} size={40} className="mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <span className={HEADLINE_CLASS}>{app.appName}</span>
            {item.publishedAt && (
              <span className="text-[11px] text-stone-400 dark:text-stone-500 shrink-0 tabular-nums mt-px">
                {formatDate(item.publishedAt)}
              </span>
            )}
          </div>
          <div className="text-[12px] mt-0.5">
            <AppPlatformCue label={app.label} />
          </div>
          {item.source.orgName && (
            <div className="flex items-center gap-1.5 text-[11px] text-stone-400 dark:text-stone-500 mt-1 min-w-0">
              {item.source.orgAvatarUrl && <OrgAvatar url={item.source.orgAvatarUrl} />}
              <span className="line-clamp-1">{item.source.orgName}</span>
            </div>
          )}
        </div>
      </Link>
    </div>
  );
}

/**
 * Strip markdown from the release summary and drop the leading copy if it's
 * just the title repeated (common for tagged GitHub releases where the title
 * is the first line of the body). Returns null when there's no usable copy
 * — callers skip the preview block entirely in that case.
 */
function releasePreview(
  item: RelatedReleaseItem,
  titleShownAsSubtitle: string | null,
): string | null {
  const stripped = stripMarkdown(item.summary);
  if (!stripped) return null;
  const deduped =
    titleShownAsSubtitle && stripped.startsWith(titleShownAsSubtitle)
      ? stripped.slice(titleShownAsSubtitle.length).trimStart()
      : stripped;
  if (!deduped) return null;
  return clamp(deduped, 140);
}
