import type {
  CollectionWeeklyDigestDetail,
  DigestCoveredRelease,
} from "@buildinternet/releases-api-types";
import { logEvent } from "@releases/lib/log-event";
import { renderEmail, type EmailBlock } from "@releases/rendering/email-shell";
import type { DigestEmailEnv } from "./digest-email.js";

/**
 * The collection weekly digest email (#2459): a short teaser for one week's
 * digest page, not the digest itself. Subject = digest title + collection + week;
 * body = the intro, the week's biggest releases, one "Read the digest" button,
 * and a quiet link to the week's replay.
 */

/** Rows in the "Biggest releases" list, matching the web card's GLANCE_TOP_N. */
export const COLLECTION_DIGEST_TOP_N = 5;

/** The web card (and so the replay link) needs at least this many releases. */
const MIN_RELEASES_FOR_REPLAY = 3;

/** Anchor of the digest page's "Releases covered" block (web RELEASES_COVERED_ANCHOR). */
const RELEASES_COVERED_ANCHOR = "releases-covered";

const DEFAULT_FROM = "digests@releases.sh";
const FROM_NAME = "Releases Index";
const DAY_MS = 24 * 60 * 60 * 1000;

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
function monthDay(d: Date): string {
  monthDayFmt ??= new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return monthDayFmt.format(d);
}

/** "Sep 28 – Oct 4" for an ET-Monday `weekStart` (YYYY-MM-DD). */
export function weekRangeShort(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start.getTime() + 6 * DAY_MS);
  const to = start.getUTCMonth() === end.getUTCMonth() ? String(end.getUTCDate()) : monthDay(end);
  return `${monthDay(start)} – ${to}`;
}

/**
 * The week's biggest releases: importance descending, ties kept in the digest's
 * citation order. The web card ranks by its impact score; this is the plain
 * importance ranking the issue allows so the API doesn't need the web's math.
 */
export function biggestReleases(
  releases: readonly DigestCoveredRelease[],
  n = COLLECTION_DIGEST_TOP_N,
): DigestCoveredRelease[] {
  return releases.toSorted((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, n);
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

/**
 * Render + send one collection digest. Never throws: a missing binding or send
 * error comes back as `{ sent: false }`. Adds RFC 8058 one-click unsubscribe
 * headers scoped to this collection.
 */
export async function sendCollectionDigestEmail(
  env: DigestEmailEnv,
  input: CollectionDigestEmailInput,
): Promise<{ sent: boolean; reason?: "no_binding" | "error" }> {
  const { subject, text, html } = buildCollectionDigestEmail(input);
  const from = `${FROM_NAME} <${env.DIGEST_EMAIL_FROM || DEFAULT_FROM}>`;

  if (!env.AUTH_EMAIL) {
    logEvent("warn", {
      component: "collection-digest-email",
      event: "email-no-binding",
      collection: input.collection.slug,
      environment: env.ENVIRONMENT,
    });
    return { sent: false, reason: "no_binding" };
  }

  try {
    await env.AUTH_EMAIL.send({
      to: input.to,
      from,
      subject,
      text,
      html,
      headers: {
        "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    return { sent: true };
  } catch (err) {
    logEvent("error", {
      component: "collection-digest-email",
      event: "email-send-failed",
      collection: input.collection.slug,
      weekStart: input.digest.weekStart,
      error: err instanceof Error ? err.message : String(err),
      environment: env.ENVIRONMENT,
    });
    return { sent: false, reason: "error" };
  }
}
