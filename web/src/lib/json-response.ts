import { NextResponse } from "next/server";

/**
 * JSON for an entity's `.json` format adapter, carrying `X-Robots-Tag: noindex`.
 *
 * A raw API payload is a machine artifact, not a page. Without this, Google
 * crawls the `.json` URLs (advertised via the sidebar's `.json · .md · .atom`
 * format links) and flags them as "Duplicate without user-selected canonical"
 * against the HTML page. Mirrors the feed treatment in `atomResponse`. Error
 * payloads keep plain `NextResponse.json` — a 4xx is already non-indexable.
 */
export function jsonFormatResponse(data: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(data, init);
  res.headers.set("X-Robots-Tag", "noindex");
  return res;
}
