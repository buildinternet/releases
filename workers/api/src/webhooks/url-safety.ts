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

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

export function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isPrivateIpv6(host: string): boolean {
  const h = normalizeHostname(host);
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(h)) return true;
  if (h.startsWith("::ffff:")) {
    const mapped = h.slice("::ffff:".length);
    const octets = parseIpv4(mapped);
    if (octets) return isPrivateIpv4(octets);
  }
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
