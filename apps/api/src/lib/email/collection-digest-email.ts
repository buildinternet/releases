import type {
  CollectionWeeklyDigestDetail,
  DigestCoveredRelease,
} from "@buildinternet/releases-api-types";
import { addDaysToDateKey } from "@buildinternet/releases-core/dates";
import { renderEmail, type EmailBlock } from "@releases/rendering/email-shell";
import { sendDigestMail, type DigestEmailEnv } from "./digest-email.js";

/**
 * The collection weekly digest email (#2459): a short teaser for one week's
 * digest page, not the digest itself. Subject = digest title + collection + week;
 * body = the intro, the week's biggest releases, one "Read the digest" button,
 * and a quiet link to the week's replay.
 */

/** Rows in the "Biggest releases" list, matching the web card's GLANCE_TOP_N. */
const TOP_N = 5;

/** The web card (and so the replay link) needs at least this many releases. */
const MIN_RELEASES_FOR_REPLAY = 3;

/** Anchor of the digest page's "Releases covered" block (web RELEASES_COVERED_ANCHOR). */
const RELEASES_COVERED_ANCHOR = "releases-covered";

export interface CollectionDigestEmailContent {
  collection: { slug: string; name: string };
  digest: Pick<CollectionWeeklyDigestDetail, "weekStart" | "title" | "intro" | "releases"> & {
    sections?: Array<{ anchor: string; releaseIds: string[] }>;
  };
  /** Web origin, e.g. https://releases.sh. */
  baseUrl: string;
  /** One-click unsubscribe URL for this collection only. */
  unsubscribeUrl: string;
}

export type CollectionDigestEmailInput = CollectionDigestEmailContent & { to: string };

let monthDayFmt: Intl.DateTimeFormat | undefined;
function monthDay(dateKey: string): string {
  monthDayFmt ??= new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return monthDayFmt.format(new Date(`${dateKey}T00:00:00Z`));
}

/** "Sep 28 – Oct 4" (or "Sep 14 – 20") for an ET-Monday `weekStart` (YYYY-MM-DD). */
export function weekRangeShort(weekStart: string): string {
  const end = addDaysToDateKey(weekStart, 6);
  const to =
    end.slice(0, 7) === weekStart.slice(0, 7) ? String(Number(end.slice(8))) : monthDay(end);
  return `${monthDay(weekStart)} – ${to}`;
}

/**
 * The week's biggest releases: importance descending, ties kept in the digest's
 * citation order. The web card ranks by its impact score; this is the plain
 * importance ranking the issue allows so the API doesn't need the web's math.
 */
export function biggestReleases(releases: readonly DigestCoveredRelease[]): DigestCoveredRelease[] {
  return releases.toSorted((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, TOP_N);
}

/** First section that cites the release, else the "Releases covered" block. */
function sectionAnchor(
  sections: CollectionDigestEmailContent["digest"]["sections"],
  releaseId: string,
): string {
  return (
    (sections ?? []).find((s) => s.releaseIds.includes(releaseId))?.anchor ??
    RELEASES_COVERED_ANCHOR
  );
}

export function buildCollectionDigestEmail(content: CollectionDigestEmailContent): {
  subject: string;
  text: string;
  html: string;
} {
  const { collection, digest, baseUrl, unsubscribeUrl } = content;
  const range = weekRangeShort(digest.weekStart);
  const digestUrl = `${baseUrl}/collections/${collection.slug}/digest/${digest.weekStart}`;
  const subject = `${digest.title} — ${collection.name} · ${range}`;

  const top = biggestReleases(digest.releases);
  const blocks: EmailBlock[] = [{ t: "p", text: digest.intro }];
  if (top.length > 0) {
    blocks.push({
      t: "orgGroup",
      name: "Biggest releases",
      posts: top.map((r) => ({
        title: r.title,
        url: `${digestUrl}#${sectionAnchor(digest.sections, r.id)}`,
        meta: r.product?.name ?? r.org.name,
        highSignal: (r.importance ?? 0) >= 4,
      })),
    });
  }
  blocks.push({ t: "button", label: "Read the digest", url: digestUrl });
  if (digest.releases.length >= MIN_RELEASES_FOR_REPLAY) {
    blocks.push({ t: "fine", text: `[Watch this week replayed (35s)](${digestUrl}/replay)` });
  }

  const { html, text } = renderEmail({
    lane: `Digest · ${collection.name}`,
    title: digest.title,
    subtitle: `${collection.name} · ${range}`,
    preheader: digest.intro,
    blocks,
    footer: {
      reason: `You subscribed to the ${collection.name} weekly digest on Releases Index.`,
      links: [
        { label: "Manage", href: `${baseUrl}/collections/${collection.slug}` },
        { label: "Unsubscribe from this digest", href: unsubscribeUrl },
      ],
    },
    action: { kind: "view", name: "Read digest", url: digestUrl },
  });

  return { subject, text, html };
}

/** Render + send one collection digest. Never throws (see `sendDigestMail`). */
export async function sendCollectionDigestEmail(
  env: DigestEmailEnv,
  input: CollectionDigestEmailInput,
): Promise<{ sent: boolean; reason?: "no_binding" | "error" }> {
  const { subject, text, html } = buildCollectionDigestEmail(input);
  return sendDigestMail(
    env,
    { to: input.to, subject, text, html, unsubscribeUrl: input.unsubscribeUrl },
    {
      component: "collection-digest-email",
      collection: input.collection.slug,
      weekStart: input.digest.weekStart,
    },
  );
}
