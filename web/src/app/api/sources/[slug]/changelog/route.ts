import { NextResponse } from "next/server";
import { api } from "@/lib/api";
import { parseRangeParam } from "@shared/changelog-slice";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const url = new URL(req.url);
  const range = {
    path: url.searchParams.get("path") ?? undefined,
    offset: parseRangeParam(url.searchParams.get("offset")),
    limit: parseRangeParam(url.searchParams.get("limit")),
  };
  try {
    const file = await api.sourceChangelog(slug, range);
    return NextResponse.json(file, {
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" },
    });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}
