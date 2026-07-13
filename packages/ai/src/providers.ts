import { logger } from "@buildinternet/releases-lib/logger";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";

// ── Provider definitions ─────────────────────────────────────────────

export interface ProviderHints {
  /** Known feed path relative to the changelog page */
  feedPaths?: string[];
  /** Whether pages are available as raw markdown via .md suffix */
  markdownSuffix?: boolean;
  /** Suggested crawl pattern (relative to changelog root) */
  crawlPattern?: string;
  /** Preferred source type for this provider */
  preferredType?: "feed" | "scrape";
  /** Additional well-known changelog paths for this provider */
  changelogPaths?: string[];
  /** Whether this provider serves pre-rendered HTML (no JS needed for content) */
  staticContent?: boolean;
}

export interface DetectedProvider {
  id: string;
  name: string;
  hints: ProviderHints;
}

interface ProviderDef {
  id: string;
  name: string;
  hints: ProviderHints;
  /** CNAME targets that identify this provider */
  cnames?: string[];
  /** Strings to match in HTTP response headers (header name → substring) */
  headers?: Record<string, string>;
  /** Strings to match in HTML <head> content */
  htmlPatterns?: string[];
  /** URL hostname patterns */
  hostPatterns?: RegExp[];
}

// Future: Consider integrating webappanalyzer fingerprint data
// (github.com/AliasIO/wappalyzer went closed-source; use the
// github.com/enthec/webappanalyzer fork) for broader detection coverage.
// Their JSON pattern database covers thousands of technologies. We'd still
// need our custom ProviderHints layer for changelog-specific feed paths,
// markdown suffixes, and crawl patterns — webappanalyzer only identifies
// the platform, not how to extract release notes from it.
const PROVIDERS: ProviderDef[] = [
  {
    id: "mintlify",
    name: "Mintlify",
    cnames: ["mintlify.app", "mintlify.dev"],
    headers: { "x-mintlify": "", server: "mintlify" },
    htmlPatterns: ["mintlify", "__mintlify"],
    hints: {
      feedPaths: ["/rss.xml"],
      markdownSuffix: true,
      preferredType: "feed",
      changelogPaths: ["/changelog", "/docs/changelog"],
      staticContent: true,
    },
  },
  {
    id: "fern",
    name: "Fern",
    // CNAME only matches Fern's own marketing/docs site; customer docs (e.g.
    // elevenlabs.io/docs, docs.cohere.com) live on the customer domain via
    // Vercel, so detection there relies on the HTML markers below.
    cnames: ["buildwithfern.com"],
    // `buildwithfern` (asset/config references) is the reliable <head> marker —
    // present 70+ times in the head of real customer sites. The `fve-*` Fern
    // Visual Editor attributes are body-only content markers (consumed by
    // htmlToMarkdown's attribute stripping) and never appear in <head>, so they
    // don't contribute to detection (detectFromHttpSignals only scans headHtml).
    htmlPatterns: ["buildwithfern", "fern-docs", "fve-data-id", "fve-mdx-b64"],
    hints: {
      // Fern appends `.rss` to the changelog path: /docs/changelog.rss or
      // /changelog.rss depending on where the changelog is mounted.
      feedPaths: ["/changelog.rss", "/docs/changelog.rss"],
      changelogPaths: ["/docs/changelog", "/changelog"],
      preferredType: "feed",
      // Fern serves fully pre-rendered HTML (content present without JS).
      staticContent: true,
      // markdownSuffix intentionally omitted: appending `.md` to the changelog
      // *index* returns a 200 text/plain "Page Not Found" (a false positive for
      // tryMarkdownSuffix). Only individual dated entries (/docs/changelog/YYYY/M/D.md)
      // serve real markdown, and those are already covered by the RSS feed.
    },
  },
  {
    id: "readme",
    name: "ReadMe",
    cnames: ["readme.io", "readmessl.com"],
    headers: { "x-readme-version": "" },
    htmlPatterns: ["readme.io", "ReadMe-"],
    hints: {
      feedPaths: ["/changelog.rss"],
      changelogPaths: ["/changelog", "/docs/changelog"],
      preferredType: "feed",
    },
  },
  {
    id: "gitbook",
    name: "GitBook",
    cnames: ["gitbook.io", "gitbook-hosting"],
    htmlPatterns: ["gitbook", "GitBook"],
    hints: {
      changelogPaths: ["/changelog"],
      preferredType: "scrape",
    },
  },
  {
    id: "docusaurus",
    name: "Docusaurus",
    htmlPatterns: ["docusaurus", "__docusaurus"],
    hints: {
      feedPaths: ["/blog/rss.xml", "/blog/atom.xml", "/blog/feed.json"],
      changelogPaths: ["/blog", "/changelog"],
      preferredType: "feed",
      staticContent: true,
    },
  },
  {
    id: "document360",
    name: "Document360",
    // Document360 help centers (e.g. help.gong.io) server-render their content and
    // carry `document360` markers (cdn.us.document360.io asset URLs, etc.) dozens of
    // times in <head>. Listed BEFORE Ghost on purpose: the Document360 bundle emits a
    // `ghost-serverApp` token that false-matches Ghost's loose `ghost-` pattern, and
    // detectFromHttpSignals is first-match-wins — so Document360 must be evaluated first.
    htmlPatterns: ["document360"],
    hints: {
      // No public RSS/Atom feed. The "what's new" pages are single-page scrape targets
      // and content is present in the initial HTML, so no headless render is needed.
      changelogPaths: ["/docs/whats-new", "/docs/release-notes", "/docs/changelog"],
      preferredType: "scrape",
      staticContent: true,
    },
  },
  {
    id: "ghost",
    name: "Ghost",
    headers: { "x-ghost-cache-status": "" },
    htmlPatterns: ["ghost-", "content/themes/"],
    cnames: ["ghost.io"],
    hints: {
      feedPaths: ["/rss/", "/rss"],
      preferredType: "feed",
      staticContent: true,
    },
  },
  {
    id: "wordpress",
    name: "WordPress",
    htmlPatterns: ["wp-content", "wp-json"],
    hints: {
      feedPaths: ["/feed/", "/feed"],
      changelogPaths: ["/category/releases", "/category/changelog", "/tag/release"],
      preferredType: "feed",
      staticContent: true,
    },
  },
  {
    id: "hashnode",
    name: "Hashnode",
    cnames: ["hashnode.network", "hashnode.dev"],
    htmlPatterns: ["hashnode"],
    hints: {
      feedPaths: ["/rss.xml"],
      preferredType: "feed",
      staticContent: true,
    },
  },
  {
    id: "nextra",
    name: "Nextra",
    htmlPatterns: ["nextra", "__nextra"],
    hints: {
      feedPaths: ["/feed.xml", "/rss.xml"],
      changelogPaths: ["/changelog", "/blog"],
      preferredType: "feed",
      staticContent: true,
    },
  },
  {
    id: "vitepress",
    name: "VitePress",
    htmlPatterns: ["vitepress", "VPContent"],
    hints: {
      feedPaths: ["/feed.xml", "/feed.rss"],
      changelogPaths: ["/changelog", "/blog"],
      preferredType: "feed",
      staticContent: true,
    },
  },
  {
    id: "blume",
    name: "Blume",
    // Blume (github.com/haydenbleasel/blume) is a self-hosted Astro changelog/docs
    // generator, not a hosted SaaS — sites deploy to their own domains (typically
    // Vercel), so there's no reliable CNAME and no custom HTTP header. Detection
    // rides on the inline anti-flash theme script Blume emits in <head>, which
    // references the `blume-theme` localStorage key. Theme switching is a core
    // (non-optional) Blume feature, so the marker is present on every page.
    // NOT usable as markers: `data-blume-banner*` (only when the optional
    // announcement banner is configured), `data-blume-search-*` / `#blume-content`
    // (body-only — detectFromHttpSignals scans <head> only), and og:site_name
    // "Blume" (present on the project's own dogfood site; self-hosters override it).
    htmlPatterns: ["blume-theme", "data-blume-"],
    hints: {
      // Blume mounts the changelog at /changelog and serves RSS 2.0 at
      // {changelogRoot}/rss.xml. Listing the absolute /changelog/rss.xml first
      // resolves the feed even when onboarding from the site root — the feed
      // autodiscovery <link> is only present on the /changelog page, not on /.
      feedPaths: ["/changelog/rss.xml", "/rss.xml"],
      changelogPaths: ["/changelog"],
      preferredType: "feed",
      // Astro serves fully pre-rendered HTML (content present without JS).
      staticContent: true,
      // markdownSuffix intentionally omitted: entry pages serve raw markdown at
      // <entry>.md, but the changelog *index* .md 404s, so tryMarkdownSuffix on
      // the index URL (the usual onboarding target) is a false negative. RSS
      // items are body-less (title/link/guid/pubDate only), so the feed enricher
      // follows each entry link for content — no markdown probe needed.
    },
  },
  {
    id: "notion",
    name: "Notion (Super/Potion)",
    cnames: ["super.so", "potion.so"],
    htmlPatterns: ["notion-", "super.so"],
    hints: {
      preferredType: "scrape",
      crawlPattern: "/**",
    },
  },
  {
    id: "vercel-docs",
    name: "Vercel/Next.js Docs",
    htmlPatterns: ["__next"],
    hints: {
      feedPaths: ["/feed.xml", "/rss.xml", "/changelog/rss.xml"],
      changelogPaths: ["/changelog"],
      preferredType: "feed",
    },
  },
  {
    id: "intercom",
    name: "Intercom",
    cnames: ["custom.intercom.help", "intercom.help"],
    headers: { "x-intercom-version": "" },
    htmlPatterns: ["intercom", "intercom-container", "js.intercomcdn.com"],
    hints: {
      // Intercom articles live at /en/articles/<id>-<slug>
      // Collections can group release notes, e.g. /en/collections/<id>-release-notes
      changelogPaths: [
        "/en/collections/release-notes",
        "/en/collections/changelog",
        "/en/collections/whats-new",
        "/en/collections/updates",
      ],
      preferredType: "scrape",
      crawlPattern: "/en/articles/**",
    },
  },
  {
    id: "zendesk",
    name: "Zendesk",
    cnames: ["zendesk.com", "zendesk-host.com"],
    headers: { "x-zendesk-request-id": "" },
    htmlPatterns: ["zendesk", "zd-", "hc-", "zendesk-host"],
    hints: {
      // Zendesk Guide (help center) uses /hc/<locale>/sections/<id> and
      // /hc/<locale>/articles/<id>. The canonical structured source is the public
      // Help Center Content API: each section's articles (full HTML body + dates +
      // canonical html_url) are served as paginated JSON at
      //   /api/v2/help_center/<locale>/sections/<id>/articles.json
      // Ingest a section as a `type: "feed"` source whose metadata.feedUrl points
      // at that articles.json endpoint plus metadata.helpCenter =
      // { provider: "zendesk", releaseType? }; the feed dispatcher routes it to
      // packages/adapters/src/helpcenter.ts instead of RSS/Atom parsing. The
      // section index itself is JS-rendered, so scrape+crawl can't read it, and
      // the legacy /hc/<locale>/articles.rss feed is gone (404s on modern Zendesk,
      // incl. Zendesk's own help center). No feedPaths probe here.
      changelogPaths: [
        "/hc/en-us/sections/release-notes",
        "/hc/en-us/sections/changelog",
        "/hc/en-us/sections/whats-new",
        "/hc/en-us/categories/release-notes",
        "/hc/en-us/categories/changelog",
      ],
      preferredType: "scrape",
      crawlPattern: "/hc/en-us/articles/**",
    },
  },
  {
    id: "helpscout",
    name: "Help Scout",
    cnames: ["helpscoutdocs.com", "secure.helpscout.net"],
    htmlPatterns: ["helpscout", "beacon-", "hs-beacon"],
    hints: {
      // Help Scout Docs uses /collection/<slug> and /article/<slug>
      changelogPaths: [
        "/collection/release-notes",
        "/collection/changelog",
        "/collection/whats-new",
      ],
      preferredType: "scrape",
      crawlPattern: "/article/**",
    },
  },
  {
    id: "freshdesk",
    name: "Freshdesk",
    cnames: ["freshdesk.com"],
    headers: { "x-freshdesk-api-version": "" },
    htmlPatterns: ["freshdesk", "freshworks"],
    hints: {
      changelogPaths: [
        "/support/solutions/folders/release-notes",
        "/support/solutions/folders/changelog",
      ],
      preferredType: "scrape",
      crawlPattern: "/support/solutions/articles/**",
    },
  },
  {
    id: "confluence",
    name: "Confluence",
    htmlPatterns: ["confluence", "ajs-", "atlassian"],
    cnames: ["atlassian.net"],
    hints: {
      changelogPaths: ["/wiki/spaces/release-notes", "/wiki/spaces/changelog"],
      preferredType: "scrape",
    },
  },
  {
    id: "productboard",
    name: "Productboard (Changelog)",
    cnames: ["productboard.com"],
    htmlPatterns: ["productboard"],
    hints: {
      feedPaths: ["/changelog.rss", "/changelog/feed"],
      changelogPaths: ["/changelog"],
      preferredType: "feed",
    },
  },
  {
    id: "headway",
    name: "Headway",
    cnames: ["headwayapp.co"],
    htmlPatterns: ["headway-widget", "headwayapp"],
    hints: {
      feedPaths: ["/feed"],
      changelogPaths: ["/"],
      preferredType: "feed",
    },
  },
  {
    id: "beamer",
    name: "Beamer",
    cnames: ["getbeamer.com"],
    htmlPatterns: ["beamer", "getbeamer"],
    hints: {
      feedPaths: ["/feed"],
      preferredType: "feed",
    },
  },
  {
    id: "launchnotes",
    name: "LaunchNotes",
    cnames: ["launchnotes.io", "launchnotes.com"],
    htmlPatterns: ["launchnotes"],
    hints: {
      feedPaths: ["/rss"],
      changelogPaths: ["/"],
      preferredType: "feed",
    },
  },
  {
    id: "canny",
    name: "Canny",
    cnames: ["canny.io"],
    htmlPatterns: ["canny", "canny_"],
    hints: {
      changelogPaths: ["/changelog"],
      preferredType: "scrape",
    },
  },
];

// ── DNS-based detection ──────────────────────────────────────────────

/**
 * Resolve CNAME records for a hostname using DNS-over-HTTPS (Cloudflare).
 * Returns the CNAME target or null.
 */
async function resolveCname(hostname: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`,
      {
        headers: { Accept: "application/dns-json" },
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    if (!res.ok) return null;

    const data = (await res.json()) as {
      Answer?: Array<{ type: number; data: string }>;
    };

    // CNAME record type = 5
    const cname = data.Answer?.find((a) => a.type === 5);
    return cname?.data?.replace(/\.$/, "") ?? null;
  } catch {
    return null;
  }
}

async function detectViaDns(hostname: string): Promise<ProviderDef | null> {
  const cname = await resolveCname(hostname);
  if (!cname) return null;

  logger.debug(`DNS CNAME for ${hostname}: ${cname}`);

  for (const provider of PROVIDERS) {
    if (!provider.cnames) continue;
    if (provider.cnames.some((c) => cname.endsWith(c))) {
      return provider;
    }
  }

  return null;
}

// ── HTTP-based detection ─────────────────────────────────────────────

interface HttpSignals {
  headers: Record<string, string>;
  headHtml: string;
}

async function fetchHttpSignals(url: string): Promise<HttpSignals | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      headers: { "User-Agent": RELEASES_BOT_UA, Accept: "text/html" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok || !res.body) return null;

    // Collect response headers
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    // Stream only enough for <head>
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- streaming response body chunk by chunk until </head> found
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes("</head>") || html.length > 32_000) {
        void reader.cancel();
        break;
      }
    }

    const headEnd = html.indexOf("</head>");
    const headHtml = headEnd > -1 ? html.slice(0, headEnd) : html;

    return { headers, headHtml };
  } catch {
    return null;
  }
}

export function detectFromHttpSignals(signals: HttpSignals): ProviderDef | null {
  for (const provider of PROVIDERS) {
    // Check headers
    if (provider.headers) {
      for (const [headerName, substring] of Object.entries(provider.headers)) {
        const value = signals.headers[headerName];
        if (value !== undefined && (substring === "" || value.includes(substring))) {
          return provider;
        }
      }
    }

    // Check HTML patterns
    if (provider.htmlPatterns) {
      for (const pattern of provider.htmlPatterns) {
        if (signals.headHtml.includes(pattern)) {
          return provider;
        }
      }
    }
  }

  return null;
}

// ── URL-based detection (fast, no network) ───────────────────────────

export function detectFromUrl(url: string): ProviderDef | null {
  try {
    const hostname = new URL(url).hostname;
    for (const provider of PROVIDERS) {
      if (provider.hostPatterns) {
        for (const re of provider.hostPatterns) {
          if (re.test(hostname)) return provider;
        }
      }
      // Direct hostname match against known CNAME targets
      if (provider.cnames) {
        for (const cname of provider.cnames) {
          if (hostname.endsWith(cname)) return provider;
        }
      }
    }
  } catch {
    /* skip */
  }
  return null;
}

// ── Main detection pipeline ──────────────────────────────────────────

/**
 * Detect the changelog hosting provider for a given URL.
 * Uses three signals in order: URL pattern → DNS CNAME → HTTP response.
 * Returns null if no known provider is detected.
 */
export async function detectProvider(url: string): Promise<DetectedProvider | null> {
  // 1. Fast URL-based check (no network)
  const fromUrl = detectFromUrl(url);
  if (fromUrl) {
    logger.debug(`Provider detected from URL: ${fromUrl.name}`);
    return { id: fromUrl.id, name: fromUrl.name, hints: fromUrl.hints };
  }

  const hostname = new URL(url).hostname;

  // 2. DNS and HTTP in parallel
  const [dnsResult, httpSignals] = await Promise.all([
    detectViaDns(hostname),
    fetchHttpSignals(url),
  ]);

  if (dnsResult) {
    logger.debug(`Provider detected from DNS: ${dnsResult.name}`);
    return { id: dnsResult.id, name: dnsResult.name, hints: dnsResult.hints };
  }

  if (httpSignals) {
    const fromHttp = detectFromHttpSignals(httpSignals);
    if (fromHttp) {
      logger.debug(`Provider detected from HTTP: ${fromHttp.name}`);
      return { id: fromHttp.id, name: fromHttp.name, hints: fromHttp.hints };
    }
  }

  return null;
}

/**
 * Detect provider for a given URL using only the cached HTTP signals.
 * Useful when you've already fetched the page and have the HTML.
 */
export function detectProviderFromHtml(
  headHtml: string,
  headers?: Record<string, string>,
): DetectedProvider | null {
  const signals: HttpSignals = { headers: headers ?? {}, headHtml };
  const provider = detectFromHttpSignals(signals);
  if (!provider) return null;
  return { id: provider.id, name: provider.name, hints: provider.hints };
}

/** Get provider hints by ID (for use when provider is already stored in metadata) */
export function getProviderHints(providerId: string): ProviderHints | null {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  return provider?.hints ?? null;
}
