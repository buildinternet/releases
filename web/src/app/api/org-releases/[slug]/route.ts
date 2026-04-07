import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.RELEASED_API_URL ?? "http://localhost:3456";
const API_SECRET = process.env.RELEASED_API_KEY;

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cursor = req.nextUrl.searchParams.get("cursor") ?? "";

  const qs = new URLSearchParams();
  if (cursor) qs.set("cursor", cursor);

  const headers: Record<string, string> = {};
  if (API_SECRET) headers["Authorization"] = `Bearer ${API_SECRET}`;

  const res = await fetch(`${API_URL}/v1/orgs/${slug}/releases?${qs}`, { headers });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
