import { NextRequest, NextResponse } from "next/server";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "@/lib/env";

const API_URL = apiBaseUrl() ?? "http://localhost:3456";

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cursor = req.nextUrl.searchParams.get("cursor") ?? "";
  const sourceType = req.nextUrl.searchParams.get("source_type") ?? "";
  const includePrereleases = req.nextUrl.searchParams.get("include_prereleases") ?? "";
  const since = req.nextUrl.searchParams.get("since") ?? "";
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const product = req.nextUrl.searchParams.get("product") ?? "";

  const qs = new URLSearchParams();
  if (cursor) qs.set("cursor", cursor);
  if (sourceType) qs.set("source_type", sourceType);
  if (includePrereleases) qs.set("include_prereleases", includePrereleases);
  if (since) qs.set("since", since);
  if (q) qs.set("q", q);
  if (product) qs.set("product", product);

  const res = await fetch(`${API_URL}/v1/orgs/${slug}/releases?${qs}`, {
    headers: webApiHeaders(),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
