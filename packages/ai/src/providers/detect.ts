import { logger } from "@buildinternet/releases-lib/logger";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import type { DetectedProvider, ProviderDef, ProviderHints } from "./types.js";
import { PROVIDERS } from "./definitions.js";

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
