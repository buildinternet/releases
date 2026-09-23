import { NextResponse } from "next/server";
import { api } from "@/lib/api";
import { parseRangeParam } from "@buildinternet/releases-core/changelog-range";
import { renderChangelogHtml } from "@/lib/render-changelog-html";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgSlug: string; sourceSlug: string }> },
) {
  const { orgSlug, sourceSlug } = await params;
  const url = new URL(req.url);
  const range = {
    path: url.searchParams.get("path") ?? undefined,
    offset: parseRangeParam(url.searchParams.get("offset")),
    limit: parseRangeParam(url.searchParams.get("limit")),
  };
  try {
    const file = await api.sourceChangelog({ orgSlug, sourceSlug }, range);
    // Render the chunk to HTML server-side and drop the raw `content` from the
    // wire, so `ChangelogStream` can inject it via `dangerouslySetInnerHTML`
    // without pulling react-markdown + shiki into the client bundle (#1919).
    // `nextOffset` (a char offset into the full file) carries the load-progress
    // signal the stream needs, so the raw markdown no longer has to ride along.
    const { content, ...rest } = file;
    return NextResponse.json(
      { ...rest, contentHtml: renderChangelogHtml(content) },
      { headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" } },
    );
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}
