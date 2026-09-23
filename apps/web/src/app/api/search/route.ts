import { NextRequest, NextResponse } from "next/server";
import { api, emptyResults } from "@/lib/api";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 50;

/**
 * Same-origin proxy for the public `/v1/search` endpoint, used by the live
 * search box on the client. Reusing the server-side `api.search` keeps the
 * wire details in one place — proxy key, the `X-Releases-Surface: web` log
 * attribution, and the coordinate-shaped-query `mode=lexical` switch — and
 * keeps the API base URL + proxy secret out of the browser bundle. Calling
 * this from the client avoids a full Next route navigation per keystroke
 * (and the cross-origin preflight a direct API call would trigger).
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const limitParam = Number(req.nextUrl.searchParams.get("limit"));
  const offsetParam = Number(req.nextUrl.searchParams.get("offset"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : 20;
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;
  // Forwarded verbatim to /v1/search; the API validates the format (ISO or
  // relative shorthand) and 400s on bad input. The client only ever sends a
  // known-good preset shorthand.
  const since = req.nextUrl.searchParams.get("since") ?? undefined;

  if (!q.trim()) {
    return NextResponse.json(emptyResults(q));
  }

  try {
    const results = await api.search(q, limit, offset, since);
    return NextResponse.json(results);
  } catch {
    // Mirror the search page's server fallback: an empty result set rather
    // than a 500 so the box degrades to "no results" instead of breaking.
    return NextResponse.json(emptyResults(q));
  }
}
