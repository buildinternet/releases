import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { etWeekStart, isDateKey } from "@buildinternet/releases-core/dates";
import { ApiNotFoundError, ApiSetupError } from "@/lib/api";
import { SetupMessage } from "@/components/setup-message";
import { BreadcrumbHome } from "@/components/breadcrumb-home";
import { ReplayStage } from "@/components/digest-replay/replay-stage";
import { releaseSectionAnchors } from "@/lib/digest-glance";
import { weekRangeLabel } from "@/lib/digest-format";
import { enableOnDemandIsr } from "@/lib/static-params";
import { getDigestPage } from "../../_lib/digest-data";

// Same window as the digest page this replays.
export const revalidate = 86400;
export const generateStaticParams = enableOnDemandIsr;

/** Under this many releases there's nothing to watch: open on the end state. */
const MIN_PLAYBACK_RELEASES = 3;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; week: string }>;
}): Promise<Metadata> {
  const { slug, week } = await params;
  // The digest page is the canonical content; the replay duplicates it.
  const base: Metadata = { title: "Digest replay", robots: { index: false, follow: true } };
  if (!isDateKey(week) || etWeekStart(week) !== week) return base;
  try {
    const { detail, digest } = await getDigestPage(slug, week);
    return {
      ...base,
      title: { absolute: `Replay: ${detail.name}, ${weekRangeLabel(week)}` },
      description: digest.intro,
      alternates: { canonical: `/collections/${slug}/digest/${week}` },
    };
  } catch {
    return base;
  }
}

export default async function DigestReplayPage({
  params,
}: {
  params: Promise<{ slug: string; week: string }>;
}) {
  const { slug, week } = await params;
  if (!isDateKey(week)) notFound();
  const canonicalWeek = etWeekStart(week);
  if (canonicalWeek !== week) {
    permanentRedirect(`/collections/${slug}/digest/${canonicalWeek}/replay`);
  }

  let page;
  try {
    page = await getDigestPage(slug, week);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  const { detail, digest } = page;
  const digestHref = `/collections/${slug}/digest/${week}`;
  const anchors = Object.fromEntries(releaseSectionAnchors(digest.sections ?? []));
  const crumbSep = (
    <span className="text-[var(--line-2)]" aria-hidden>
      /
    </span>
  );
  const crumbLink = "transition-colors hover:text-[var(--fg-2)]";

  return (
    <div className="org-surface min-h-screen bg-[var(--page)] text-[var(--fg)]">
      <main className="mx-auto flex max-w-[1160px] flex-col gap-5 px-6 pb-16 pt-5 max-[520px]:px-4">
        <div className="flex flex-col gap-2">
          <nav
            aria-label="Breadcrumb"
            className="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--fg-3)]"
          >
            <BreadcrumbHome />
            {crumbSep}
            <Link href={`/collections/${slug}`} className={crumbLink}>
              {detail.name}
            </Link>
            {crumbSep}
            <Link href={`/collections/${slug}/digest`} className={crumbLink}>
              Weekly digests
            </Link>
            {crumbSep}
            <Link href={digestHref} className={crumbLink}>
              {weekRangeLabel(week, { year: false })}
            </Link>
            {crumbSep}
            <span className="text-[var(--fg-2)]">Replay</span>
          </nav>
          <h1 className="text-balance text-[28px] font-bold leading-tight tracking-tight">
            {digest.title}
          </h1>
          <p className="text-[14px] font-medium text-[var(--fg-3)]">
            Replay of {weekRangeLabel(week)}
          </p>
        </div>

        <ReplayStage
          releases={digest.releases}
          weekStart={week}
          anchors={anchors}
          digestHref={digestHref}
          startAtEnd={digest.releases.length < MIN_PLAYBACK_RELEASES}
        />
      </main>
    </div>
  );
}
