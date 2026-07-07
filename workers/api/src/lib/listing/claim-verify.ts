import type { ClaimCheckOutcome } from "@buildinternet/releases-api-types";
import { isPrivateOrLocalHost } from "../avatar-ingest.js";

export type { ClaimCheckOutcome };

export interface ClaimVerifyChecks {
  wellKnown: ClaimCheckOutcome;
  dnsTxt: ClaimCheckOutcome;
}

export interface ClaimVerifyResult {
  verified: boolean;
  method: "well-known" | "dns-txt" | null;
  checked: ClaimVerifyChecks;
}

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;

/**
 * Very small heuristic for "this response is a challenge/interstitial page,
 * not the plain-text token" — fail closed rather than mismatch, since we
 * cannot distinguish this from "the token happens to differ" reliably.
 */
function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 256).trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("<body");
}

/**
 * Reads a response body via a streaming reader, aborting (cancelling the
 * reader) as soon as the accumulated byte total exceeds MAX_BYTES instead of
 * letting an unbounded body fully buffer via res.text() first. Returns null
 * if the body is oversized or the stream can't be read.
 */
async function readBoundedText(res: Response): Promise<string | null> {
  if (!res.body) {
    // No readable stream available (e.g. some test doubles) — fall back to
    // buffering, still bounded by a length check.
    const text = await res.text();
    return text.length > MAX_BYTES ? null : text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function checkWellKnown(
  domain: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ClaimCheckOutcome> {
  let url: URL;
  try {
    url = new URL(`https://${domain}/.well-known/releases-verify.txt`);
  } catch {
    return "unreachable";
  }
  if (url.protocol !== "https:") return "unreachable";
  if (isPrivateOrLocalHost(url.hostname)) return "unreachable";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { accept: "text/plain", "user-agent": "releases.sh claim verify" },
      });
    } catch {
      return "unreachable";
    }
    if (res.status !== 200) return "unreachable";

    let text: string | null;
    try {
      text = await readBoundedText(res);
    } catch {
      return "unreachable";
    }
    if (text === null) return "unreachable";
    if (looksLikeHtml(text)) return "unreachable";
    return text.trim() === token ? "ok" : "mismatch";
  } finally {
    clearTimeout(timer);
  }
}

interface DohAnswer {
  name?: string;
  type?: number;
  data?: string;
}
interface DohResponse {
  Status?: number;
  Answer?: DohAnswer[];
}

/** Strip a single pair of surrounding double quotes, if present. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

async function checkDnsTxt(
  domain: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ClaimCheckOutcome> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(
    `_releases-challenge.${domain}`,
  )}&type=TXT`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { accept: "application/dns-json" },
      });
    } catch {
      return "unreachable";
    }
    if (res.status !== 200) return "unreachable";

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return "unreachable";
    }
    if (typeof body !== "object" || body === null) return "unreachable";
    const doh = body as DohResponse;
    // DNS RCODE: 0 = NOERROR. Anything else (including 3 = NXDOMAIN) is a
    // clean "not published" signal, not an infra failure — mismatch, not
    // unreachable. A missing/non-numeric Status is ambiguous → unreachable.
    if (typeof doh.Status !== "number") return "unreachable";
    if (doh.Status !== 0) return "mismatch";
    const answers = Array.isArray(doh.Answer) ? doh.Answer : [];
    for (const answer of answers) {
      if (typeof answer?.data !== "string") continue;
      // A TXT value can arrive as multiple quoted strings concatenated with a
      // space (e.g. `"part1" "part2"`); join them before comparing.
      const joined = answer.data
        .split(/\s+/)
        .map((part) => unquote(part))
        .join("");
      if (joined === token) return "ok";
    }
    return "mismatch";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks both proof mechanisms for a claim token and reports whether either
 * passed. Always runs both checks (even after a well-known success) so
 * `checked` is complete for the owner-facing debug UI. Fails closed: any
 * ambiguous or unparseable response maps to `mismatch`/`unreachable`, never
 * `ok`.
 */
export async function verifyDomainControl(
  domain: string,
  token: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ClaimVerifyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const [wellKnown, dnsTxt] = await Promise.all([
    checkWellKnown(domain, token, fetchImpl),
    checkDnsTxt(domain, token, fetchImpl),
  ]);
  const verified = wellKnown === "ok" || dnsTxt === "ok";
  const method: "well-known" | "dns-txt" | null =
    wellKnown === "ok" ? "well-known" : dnsTxt === "ok" ? "dns-txt" : null;
  return { verified, method, checked: { wellKnown, dnsTxt } };
}
