import { NextRequest, NextResponse } from "next/server";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "@/lib/env";
import { renderReleaseFullBodyHtml } from "@/lib/render-release-body";

const API_URL = apiBaseUrl() ?? "http://localhost:3456";

/**
 * Lazy full-body renderer for `collection-timeline`'s "Show more".
 *
 * The `/collections` + `/categories` timelines server-render only the collapsed
 * excerpt into the page; the full verbatim body is deliberately kept out of the
 * initial crawlable HTML (#1606). When a user expands a card, the client fetches
 * this endpoint, which re-reads the release, renders its full body to sanitized
 * HTML server-side (so shiki + react-markdown never reach the browser bundle),
 * and returns `{ bodyHtml }` for injection via `dangerouslySetInnerHTML`.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await fetch(`${API_URL}/v1/releases/${encodeURIComponent(id)}`, {
    headers: webApiHeaders(),
  });
  if (!res.ok) {
    return NextResponse.json({ error: "Release not found" }, { status: res.status });
  }
  const release = await res.json();
  const bodyHtml = renderReleaseFullBodyHtml(release);
  // The rendered body is stable for a given release; let the browser cache it so
  // collapse/re-expand and repeat visits don't re-render. Not indexable content
  // (JSON, user-action-gated), so `X-Robots-Tag` keeps it out of any crawl.
  return NextResponse.json(
    { bodyHtml },
    {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
        "X-Robots-Tag": "noindex",
      },
    },
  );
}
