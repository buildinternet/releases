import { NextResponse } from "next/server";
import { api } from "@/lib/api";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const url = new URL(req.url);
  const offsetRaw = url.searchParams.get("offset");
  const limitRaw = url.searchParams.get("limit");
  const range: { offset?: number; limit?: number } = {};
  if (offsetRaw != null) {
    const n = Number(offsetRaw);
    if (Number.isFinite(n) && n >= 0) range.offset = n;
  }
  if (limitRaw != null) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n > 0) range.limit = n;
  }
  try {
    const file = await api.sourceChangelog(slug, range);
    return NextResponse.json(file, {
      headers: { "Cache-Control": "public, max-age=60, s-maxage=60" },
    });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}
