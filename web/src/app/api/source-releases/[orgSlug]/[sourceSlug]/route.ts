import { NextRequest, NextResponse } from "next/server";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "@/lib/env";

const API_URL = apiBaseUrl() ?? "http://localhost:3456";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgSlug: string; sourceSlug: string }> },
) {
  const { orgSlug, sourceSlug } = await params;
  const cursor = req.nextUrl.searchParams.get("cursor") ?? "";
  const includePrereleases = req.nextUrl.searchParams.get("include_prereleases") ?? "";
  const q = req.nextUrl.searchParams.get("q") ?? "";

  const qs = new URLSearchParams();
  if (cursor) qs.set("cursor", cursor);
  if (includePrereleases) qs.set("include_prereleases", includePrereleases);
  if (q) qs.set("q", q);

  const res = await fetch(`${API_URL}/v1/orgs/${orgSlug}/sources/${sourceSlug}/releases?${qs}`, {
    headers: webApiHeaders(),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
