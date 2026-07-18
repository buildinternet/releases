import Link from "next/link";
import type { OrgReleaseItem } from "@/lib/api";
import { formatDate } from "@/lib/formatters";
import { pickReleaseThumb } from "@/lib/media";
import { appRowInfoFromWire } from "@/lib/app-source";
import { orgEyebrowClass } from "@releases/design-system";
import { ImportanceMarker } from "../importance-marker";
import { ReleaseThumb } from "../release-thumb";
import { AppStoreIcon } from "../app-store-icon";
import { AppPlatformCue } from "../app-platform-cue";
import { ArrowRightIcon, ChevronRightIcon } from "./icons";

/**
 * Overview "Latest releases" teaser — a short card of the newest releases that
 * links through to the full Releases tab. A read-only summary; the Releases tab
 * owns filtering, search, and per-release actions.
 */
export function LatestReleasesTeaser({
  orgSlug,
  releases,
  count = 3,
}: {
  orgSlug: string;
  releases: OrgReleaseItem[];
  count?: number;
}) {
  const items = releases.slice(0, count);
  if (items.length === 0) return null;
  // Releases is the bare org URL (default tab); `/:org/releases` 308s here.
  const releasesHref = `/${orgSlug}`;

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className={orgEyebrowClass}>Latest releases</h2>
        <Link
          href={releasesHref}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--accent)]"
        >
          See all releases
          <ArrowRightIcon className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--surface)]">
        {items.map((r, i) => {
          // Mobile-app release: lead with the app icon, headline the app name,
          // and swap the "product · version" meta for a muted "iOS/macOS app"
          // cue — the version carries no meaning for a routine app update.
          // `appStore` is set only for `appstore` sources. #mobile-app-release-cards
          const app = appRowInfoFromWire(r.source.appStore, r.product?.name ?? r.source.name);
          const label = app ? app.appName : r.titleShort || r.title;
          const meta = app ? null : [r.product?.name, r.version].filter(Boolean).join(" · ");
          const thumb = app ? null : pickReleaseThumb(r.media);
          return (
            <Link
              key={r.id ?? `${label}-${i}`}
              href={releasesHref}
              className="flex items-center gap-3.5 border-t border-[var(--line)] px-4 py-3.5 transition-colors first:border-t-0 hover:bg-[var(--surface-2)]"
            >
              {app ? (
                <AppStoreIcon iconUrl={app.iconUrl} appName={app.appName} size={36} />
              ) : (
                thumb && <ReleaseThumb src={thumb.url} alt={thumb.alt} size="md" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 truncate text-[14px] font-semibold text-[var(--fg)]">
                  <ImportanceMarker importance={r.importance} />
                  <span className="truncate">{label}</span>
                </div>
                {app ? (
                  <div className="mt-0.5 truncate text-[11.5px]">
                    <AppPlatformCue label={app.label} />
                  </div>
                ) : (
                  meta && (
                    <div className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--fg-3)]">
                      {meta}
                    </div>
                  )
                )}
              </div>
              {r.publishedAt && (
                <span className="shrink-0 font-mono text-[11.5px] text-[var(--fg-3)]">
                  {formatDate(r.publishedAt)}
                </span>
              )}
              <ChevronRightIcon className="h-[15px] w-[15px] shrink-0 text-[var(--fg-3)]" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
