/**
 * SSRF gates for outbound webhook targets. Shared by the API worker
 * (subscription create/patch) and the webhooks delivery worker (re-check at
 * send time so a DNS rebinding after registration cannot open private IPs).
 *
 * Pure / runtime-neutral — no D1, no Workers-only APIs beyond `fetch` (injectable).
 */

import type { WebhookFormat } from "@buildinternet/releases-core/schema";

/** Cloudflare DNS-over-HTTPS JSON API (public resolver). */
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "169.254.169.254",
  "0.0.0.0",
  "[::]",
  "::",
]);

export type DnsLookup = (hostname: string) => Promise<string[]>;

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

const IPV4_OCTET_RE = /^\d{1,3}$/;

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET_RE.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * True for an IPv4 address that must never be an outbound fetch target:
 * private, loopback, link-local (incl. 169.254.169.254 metadata), CGNAT,
 * IETF protocol assignments, benchmarking, documentation, multicast,
 * reserved and broadcast ranges.
 */
export function isPrivateIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF 192.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

const HEXTET_RE = /^[0-9a-f]{1,4}$/;

/**
 * Parse an IPv6 literal (with or without brackets / zone id) into 8 hextets.
 * Handles `::` compression and a trailing dotted IPv4 (`::ffff:1.2.3.4`).
 * Returns null for anything that isn't a well-formed IPv6 address.
 */
export function parseIpv6(host: string): number[] | null {
  let h = normalizeHostname(host);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const zone = h.indexOf("%");
  if (zone !== -1) h = h.slice(0, zone);
  if (!h.includes(":")) return null;

  let tail: number[] = [];
  const lastColon = h.lastIndexOf(":");
  const maybeV4 = h.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIpv4(maybeV4);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    h = h.slice(0, lastColon + 1) + "0:0"; // two placeholder hextets, replaced below
  }

  const halves = h.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const parts = side.split(":");
    const out: number[] = [];
    for (const part of parts) {
      if (!HEXTET_RE.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const head = parseSide(halves[0]!);
  const rest = halves.length === 2 ? parseSide(halves[1]!) : [];
  if (!head || !rest) return null;

  let hextets: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    hextets = [...head, ...Array<number>(fill).fill(0), ...rest];
  } else {
    hextets = head;
  }
  if (hextets.length !== 8) return null;
  if (tail.length === 2) hextets.splice(6, 2, tail[0]!, tail[1]!);
  return hextets;
}

function embeddedIpv4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * True for an IPv6 literal that must never be an outbound fetch target, or
 * that embeds an IPv4 address which must not be (mapped, compatible, NAT64,
 * 6to4). Accepts the bracketed form `URL.hostname` returns (`[::1]`). An
 * unparseable value is treated as private (fail closed).
 */
export function isPrivateIpv6(host: string): boolean {
  const x = parseIpv6(host);
  if (!x) return true;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = x as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const firstSixZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;
  if (firstSixZero && h5 === 0) {
    // :: (unspecified), ::1 (loopback), ::a.b.c.d (deprecated v4-compatible)
    if (h6 === 0 && (h7 === 0 || h7 === 1)) return true;
    return isPrivateIpv4(embeddedIpv4(h6, h7));
  }
  if (firstSixZero && h5 === 0xffff) return isPrivateIpv4(embeddedIpv4(h6, h7)); // ::ffff:0:0/96
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0) {
    return isPrivateIpv4(embeddedIpv4(h6, h7)); // ::ffff:0:0:0/96 SIIT
  }
  if (h0 === 0x64 && h1 === 0xff9b) {
    if (h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
      return isPrivateIpv4(embeddedIpv4(h6, h7)); // NAT64 64:ff9b::/96
    }
    if (h2 === 1) return true; // local-use NAT64 64:ff9b:1::/48
  }
  if (h0 === 0x2002) return isPrivateIpv4(embeddedIpv4(h1, h2)); // 6to4 2002::/16
  if (h0 === 0x2001 && h1 === 0) return true; // Teredo 2001::/32 (embeds an obfuscated v4)
  if (h0 === 0x2001 && h1 === 0xdb8) return true; // documentation
  if (h0 === 0x100 && h1 === 0 && h2 === 0 && h3 === 0) return true; // discard 100::/64
  if ((h0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((h0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if ((h0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

export function isPrivateOrReservedIp(host: string): boolean {
  const h = normalizeHostname(host);
  const v4 = parseIpv4(h);
  if (v4) return isPrivateIpv4(v4);
  if (h.includes(":")) return isPrivateIpv6(h);
  return false;
}

/** HTTPS scheme + synchronous hostname / literal-IP checks (no DNS). */
export function validateWebhookUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url is invalid";
  }
  if (parsed.protocol !== "https:") {
    return "url must use HTTPS";
  }
  const hostError = blockedWebhookHostname(parsed.hostname);
  if (hostError) return hostError;
  return null;
}

/** Synchronous hostname / literal-IP checks (no DNS). */
export function blockedWebhookHostname(hostname: string): string | null {
  const h = normalizeHostname(hostname);
  if (BLOCKED_HOSTNAMES.has(h)) {
    return "url must not target localhost, link-local, or metadata addresses";
  }
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return "url must not target private or internal hostnames";
  }
  if (isPrivateOrReservedIp(h)) {
    return "url must not target a private or reserved address";
  }
  return null;
}

function isIpLiteral(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  return parseIpv4(h) !== null || h.includes(":");
}

interface DohAnswer {
  type?: number;
  data?: string;
}

interface DohResponse {
  Answer?: DohAnswer[];
}

/** Default DoH lookup for registration-time SSRF checks. */
export async function resolveHostAddresses(
  hostname: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const types = [1, 28] as const; // A, AAAA
  const ips = new Set<string>();
  for (const type of types) {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
    const res = await fetchImpl(url, { headers: { accept: "application/dns-json" } });
    if (!res.ok) continue;
    const json = (await res.json()) as DohResponse;
    for (const answer of json.Answer ?? []) {
      if ((answer.type === 1 || answer.type === 28) && answer.data) {
        ips.add(answer.data);
      }
    }
  }
  return [...ips];
}

/** Slack incoming-webhook hosts: standard + Enterprise Grid share hooks.slack.com; GovSlack uses hooks.slack-gov.com. */
const SLACK_WEBHOOK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);

/** Host allowlist for `format = slack` subscriptions. Returns an error message or null. */
export function validateSlackWebhookUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url is invalid";
  }
  if (!SLACK_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return "Slack webhooks must point at a hooks.slack.com incoming webhook URL";
  }
  return null;
}

/**
 * Discord incoming-webhook hosts: stable + legacy discordapp.com, plus
 * canary/PTB clients that mint webhooks on their own origin.
 */
const DISCORD_WEBHOOK_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com",
]);

/** `/api/webhooks/{id}/{token}` with optional API version; no `/slack` or `/github` suffix. */
const DISCORD_WEBHOOK_PATH = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_.-]+\/?$/;

/** Host + path allowlist for `format = discord` subscriptions. Returns an error message or null. */
export function validateDiscordWebhookUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url is invalid";
  }
  if (!DISCORD_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return "Discord webhooks must point at a discord.com incoming webhook URL";
  }
  if (!DISCORD_WEBHOOK_PATH.test(parsed.pathname)) {
    return "Discord webhooks must use an /api/webhooks/{id}/{token} URL";
  }
  return null;
}

/** Format-specific host/path gate. `json` has no extra constraint. */
export function validateFormatWebhookUrl(format: WebhookFormat, url: string): string | null {
  if (format === "slack") return validateSlackWebhookUrl(url);
  if (format === "discord") return validateDiscordWebhookUrl(url);
  return null;
}

/**
 * Full webhook URL validation for create/patch: HTTPS, blocked hostnames,
 * literal private IPs, and DNS resolution for domain names (reject if any
 * answer is private/reserved). Returns an error message or null when allowed.
 */
export async function assertPublicWebhookTarget(
  url: string,
  opts?: { resolveDns?: DnsLookup },
): Promise<string | null> {
  const schemeError = validateWebhookUrl(url);
  if (schemeError) return schemeError;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url is invalid";
  }

  const hostError = blockedWebhookHostname(parsed.hostname);
  if (hostError) return hostError;

  if (isIpLiteral(parsed.hostname)) return null;

  const lookup = opts?.resolveDns ?? ((host) => resolveHostAddresses(host));
  let addresses: string[];
  try {
    addresses = await lookup(parsed.hostname);
  } catch {
    return "url hostname could not be resolved";
  }

  if (addresses.length === 0) {
    return "url hostname could not be resolved";
  }

  for (const address of addresses) {
    if (isPrivateOrReservedIp(address)) {
      return "url must not resolve to a private or reserved address";
    }
  }

  return null;
}
