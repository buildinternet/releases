import { NextRequest, NextResponse } from "next/server";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "@/lib/env";

const API_URL = apiBaseUrl() ?? "http://localhost:3456";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/recommendations`, {
      method: "POST",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        "User-Agent": req.headers.get("user-agent") ?? "releases-web",
      }),
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "api_unavailable" }, { status: 502 });
  }

  const payload = await res.json().catch(() => ({ error: "upstream_error" }));
  return NextResponse.json(payload, { status: res.status });
}
