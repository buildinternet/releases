import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { webApiHeaders } from "@/lib/api";
import { isCloudflareChallengeBody } from "@/lib/cloudflare-challenge";
import { apiBaseUrl } from "@/lib/env";

/** Stay under Vercel's ~4.5MB serverless request cap (API ingest allows 8MB). */
export const ACCOUNT_AVATAR_PROXY_MAX_BYTES = 4 * 1024 * 1024;

const CHALLENGE_MESSAGE =
  "Avatar upload was blocked by Cloudflare bot protection on api.releases.sh. " +
  "Add the trusted-proxy WAF skip rule (see docs/runbooks/api-trusted-proxy-waf.md) " +
  "and ensure RELEASES_PROXY_KEY is set on Vercel.";

/** Forward a session-authed call to the API worker without a cross-origin browser hop. */
export async function forwardAccountApi(
  method: string,
  upstreamPath: string,
  opts: { body?: ArrayBuffer; contentType?: string | null } = {},
): Promise<NextResponse> {
  const base = apiBaseUrl();
  if (!base) {
    return NextResponse.json(
      { error: "unavailable", message: "API not configured" },
      { status: 503 },
    );
  }

  const cookie = (await cookies()).toString();
  if (!cookie) {
    return NextResponse.json(
      { error: "unauthorized", message: "Sign in required" },
      { status: 401 },
    );
  }

  const extra: Record<string, string> = { Cookie: cookie };
  if (opts.contentType) extra["Content-Type"] = opts.contentType;
  const headers = webApiHeaders(extra);

  const init: RequestInit = { method, headers, cache: "no-store" };
  if (opts.body && opts.body.byteLength > 0) init.body = opts.body;

  const res = await fetch(`${base.replace(/\/+$/, "")}${upstreamPath}`, init);
  const body = await res.arrayBuffer();

  if (isCloudflareChallengeBody(res.headers.get("content-type"), body)) {
    return NextResponse.json(
      { error: "edge_blocked", message: CHALLENGE_MESSAGE },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }

  const out = new Headers();
  const upstreamType = res.headers.get("content-type");
  if (upstreamType) out.set("content-type", upstreamType);
  out.set("cache-control", "private, no-store");
  return new NextResponse(body, { status: res.status, headers: out });
}
