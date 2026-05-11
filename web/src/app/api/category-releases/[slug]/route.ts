import { NextRequest, NextResponse } from "next/server";
import { isValidCategory } from "@buildinternet/releases-core/categories";
import { webApiHeaders } from "@/lib/api";

const API_URL = process.env.RELEASED_API_URL ?? "http://localhost:3456";

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidCategory(slug)) {
    return NextResponse.json(
      { error: "not_found", message: "Category not found" },
      { status: 404 },
    );
  }
  const cursor = req.nextUrl.searchParams.get("cursor") ?? "";
  const includePrereleases = req.nextUrl.searchParams.get("include_prereleases") ?? "";

  const qs = new URLSearchParams();
  if (cursor) qs.set("cursor", cursor);
  if (includePrereleases) qs.set("include_prereleases", includePrereleases);

  const res = await fetch(`${API_URL}/v1/categories/${encodeURIComponent(slug)}/releases?${qs}`, {
    headers: webApiHeaders(),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
