/**
 * Inline hosted-video detection + oEmbed poster resolution (#1549).
 *
 * Release bodies sometimes carry a bare link to a hosted video — e.g. Robin's
 * `[Video](https://fast.wistia.com/embed/iframe/wh6pjz981z)` — which renders as
 * an easy-to-miss text link. This module detects well-known video-embed
 * providers (Wistia / Loom / Vimeo / YouTube) in a body, resolves a
 * poster/thumbnail (+ title + canonical watch URL) via the provider's oEmbed
 * endpoint, and returns `media[]`-shaped entries the ingest pipeline can mirror
 * to R2 and the web can render as a play-thumbnail card.
 *
 * Distinct from the `type: "video"` *source* path (a whole channel modeled as a
 * source): here the video is inline content within a release from a non-video
 * source.
 *
 * Worker-safe and dependency-free. Fail-open by design: an unrecognised URL, a
 * failed/slow/garbage oEmbed response, or a missing thumbnail yields no entry —
 * the bare link stays exactly as today.
 */

export type VideoEmbedProvider = "wistia" | "loom" | "vimeo" | "youtube";

/** A hosted-video link found in a body, before oEmbed resolution. */
export interface DetectedVideoLink {
  provider: VideoEmbedProvider;
  /** The provider id parsed out of the matched URL (video id / hash). */
  id: string;
  /** The exact URL as it appeared in the body. */
  matchedUrl: string;
  /** Canonical human watch URL the play-card links out to. */
  watchUrl: string;
  /** The provider oEmbed endpoint to resolve a poster/title from. */
  oembedUrl: string;
}

/**
 * A resolved inline video, shaped to drop straight into a release `media[]`
 * array. `url` is the poster (mirrored to R2 like any image); `linkUrl` is the
 * watch URL the card links out to.
 */
export interface InlineVideoMedia {
  type: "video";
  url: string;
  alt?: string;
  linkUrl: string;
}

interface ProviderMatcher {
  provider: VideoEmbedProvider;
  /** Host suffixes that identify this provider. */
  hosts: string[];
  /**
   * Extract the provider id from a URL's pathname/search, or null if the URL
   * isn't an embeddable video for this provider.
   */
  extractId: (u: URL) => string | null;
  /** Canonical watch URL from an id. */
  watchUrl: (id: string) => string;
  /** oEmbed endpoint that returns `{ thumbnail_url, title, type }` for the id. */
  oembedUrl: (id: string, watchUrl: string) => string;
}

const MATCHERS: ProviderMatcher[] = [
  {
    provider: "wistia",
    hosts: ["wistia.com", "wistia.net", "wi.st"],
    // /embed/iframe/<id>, /embed/medias/<id>(.jsonp), /medias/<id>
    extractId: (u) => {
      const m = u.pathname.match(/\/(?:embed\/(?:iframe|medias)|medias)\/([A-Za-z0-9]+)/);
      return m ? m[1]! : null;
    },
    // The publicly-loadable embed form. The prettier `fast.wistia.com/medias/<id>`
    // URL 302-redirects anonymous viewers to a login page (`/session/new`),
    // whereas `/embed/iframe/<id>` returns 200 and loads the player for everyone,
    // so it's the correct click target for the play-card. oEmbed still keys off
    // the documented `medias/<id>` URL (derived from the id, below).
    watchUrl: (id) => `https://fast.wistia.com/embed/iframe/${id}`,
    oembedUrl: (id) =>
      `https://fast.wistia.com/oembed?url=${encodeURIComponent(`https://fast.wistia.com/medias/${id}`)}`,
  },
  {
    provider: "loom",
    hosts: ["loom.com"],
    // /share/<id>, /embed/<id>
    extractId: (u) => {
      const m = u.pathname.match(/\/(?:share|embed)\/([A-Za-z0-9]+)/);
      return m ? m[1]! : null;
    },
    watchUrl: (id) => `https://www.loom.com/share/${id}`,
    oembedUrl: (_id, watchUrl) =>
      `https://www.loom.com/v1/oembed?url=${encodeURIComponent(watchUrl)}`,
  },
  {
    provider: "vimeo",
    hosts: ["vimeo.com", "player.vimeo.com"],
    // player.vimeo.com/video/<id>, vimeo.com/<id>
    extractId: (u) => {
      const m = u.pathname.match(/\/(?:video\/)?(\d+)/);
      return m ? m[1]! : null;
    },
    watchUrl: (id) => `https://vimeo.com/${id}`,
    oembedUrl: (_id, watchUrl) =>
      `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(watchUrl)}`,
  },
  {
    provider: "youtube",
    hosts: ["youtube.com", "youtube-nocookie.com", "youtu.be"],
    // watch?v=<id>, /embed/<id>, /shorts/<id>, youtu.be/<id>
    extractId: (u) => {
      const host = u.hostname.replace(/^www\./, "");
      if (host === "youtu.be") {
        const seg = u.pathname.slice(1).split("/")[0];
        return /^[A-Za-z0-9_-]{11}$/.test(seg ?? "") ? seg! : null;
      }
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/);
      return m ? m[1]! : null;
    },
    watchUrl: (id) => `https://www.youtube.com/watch?v=${id}`,
    oembedUrl: (_id, watchUrl) =>
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`,
  },
];

/**
 * Distinct provider host substrings backing the `MATCHERS` above. Exported so a
 * coarse SQL prefilter (the #1549 backfill candidate scan) derives its host
 * `LIKE` list from the same source of truth as detection instead of hardcoding
 * one that silently drifts when a provider/host is added. Substring-safe: a body
 * containing one of these MAY carry a video — `detectInlineVideos` is the real
 * per-row gate.
 */
export const VIDEO_EMBED_HOST_HINTS: readonly string[] = Array.from(
  new Set(MATCHERS.flatMap((m) => m.hosts)),
);

function matcherForHost(hostname: string): ProviderMatcher | null {
  const host = hostname.toLowerCase();
  for (const m of MATCHERS) {
    if (m.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return m;
  }
  return null;
}

/** A canonicalized video reference: which provider, the stable id, and the
 *  public watch URL. */
export interface CanonicalVideo {
  provider: VideoEmbedProvider;
  /** The provider's stable video id — the same id across every URL form. */
  id: string;
  /** Canonical, publicly-loadable watch URL for this id. */
  watchUrl: string;
}

/**
 * Map an arbitrary URL to its provider + canonical video id (+ watch URL), or
 * null if it isn't a recognised hosted-video URL. Pure + synchronous — no
 * network. Built on the same `matcherForHost` + `extractId` logic as
 * {@link detectInlineVideoLinks}, so every URL form for a given video
 * (`embed/iframe/<id>`, `medias/<id>`, `share/<id>`, `watch?v=<id>`,
 * `youtu.be/<id>`, …) collapses to the SAME `{ provider, id }`.
 *
 * The web `a`-renderer uses this to (a) decide whether a body link is a
 * video-embed URL and (b) match it to a stored `media[]` item BY ID — matching
 * on the id (not a raw watch-URL string) so rows whose stored `linkUrl` predates
 * a `watchUrl` change (e.g. the old Wistia `medias/<id>` form) still match.
 */
export function canonicalVideoFromUrl(href: string): CanonicalVideo | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const matcher = matcherForHost(u.hostname);
  if (!matcher) return null;
  const id = matcher.extractId(u);
  if (!id) return null;
  return { provider: matcher.provider, id, watchUrl: matcher.watchUrl(id) };
}

/** URL-like tokens in a markdown/HTML body — links, raw URLs, href/src attrs. */
const URL_TOKEN = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * Scan a body string for hosted-video links from known providers. Returns one
 * entry per distinct video (deduped by provider+id; first occurrence wins).
 * Pure + synchronous — no network. Order follows first appearance in the body.
 */
export function detectInlineVideoLinks(body: string | null | undefined): DetectedVideoLink[] {
  if (!body) return [];
  const seen = new Set<string>();
  const out: DetectedVideoLink[] = [];
  const matches = body.match(URL_TOKEN);
  if (!matches) return out;
  for (const raw of matches) {
    // Trim trailing punctuation that commonly clings to a URL in prose.
    const cleaned = raw.replace(/[.,);]+$/, "");
    let u: URL;
    try {
      u = new URL(cleaned);
    } catch {
      continue;
    }
    const matcher = matcherForHost(u.hostname);
    if (!matcher) continue;
    const id = matcher.extractId(u);
    if (!id) continue;
    const key = `${matcher.provider}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const watchUrl = matcher.watchUrl(id);
    out.push({
      provider: matcher.provider,
      id,
      matchedUrl: cleaned,
      watchUrl,
      oembedUrl: matcher.oembedUrl(id, watchUrl),
    });
  }
  return out;
}

/** Subset of an oEmbed response we consume. */
interface OEmbedResponse {
  type?: string;
  title?: string;
  thumbnail_url?: string;
}

const OEMBED_TIMEOUT_MS = 5_000;

/**
 * Resolve a detected video link to an {@link InlineVideoMedia} via the
 * provider's oEmbed endpoint. Returns null on any failure (non-ok response,
 * timeout, non-JSON / non-video payload, missing `thumbnail_url`) so the caller
 * fails open to the bare link. Injectable `fetchImpl` for tests — callers MUST
 * pass a mock in tests; this never hits the network on its own in test runs.
 */
export async function resolveInlineVideo(
  link: DetectedVideoLink,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<InlineVideoMedia | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? OEMBED_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(link.oembedUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as OEmbedResponse;
    // Some providers return type "video"; Loom returns "video" too. Wistia
    // returns "video". Accept any payload that carries a usable thumbnail —
    // a missing/non-string thumbnail is the only hard failure.
    const thumb = data.thumbnail_url;
    if (typeof thumb !== "string" || thumb.length === 0) return null;
    return {
      type: "video",
      url: thumb,
      alt: typeof data.title === "string" && data.title.length > 0 ? data.title : undefined,
      linkUrl: link.watchUrl,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect + resolve all inline hosted-video links in a body, bounded by
 * `maxVideos` (default 4) so a body crammed with embeds can't fan out an
 * unbounded number of oEmbed calls. Returns the resolved {@link InlineVideoMedia}
 * entries (failures dropped). Concurrent resolution; fail-open per link.
 */
export async function detectInlineVideos(
  body: string | null | undefined,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; maxVideos?: number },
): Promise<InlineVideoMedia[]> {
  const links = detectInlineVideoLinks(body).slice(0, opts?.maxVideos ?? 4);
  if (links.length === 0) return [];
  const resolved = await Promise.all(
    links.map((l) =>
      resolveInlineVideo(l, { fetchImpl: opts?.fetchImpl, timeoutMs: opts?.timeoutMs }),
    ),
  );
  return resolved.filter((m): m is InlineVideoMedia => m !== null);
}
