import { NextRequest, NextResponse } from "next/server";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "@/lib/env";

const API_URL = apiBaseUrl() ?? "http://localhost:3456";
const UPSTREAM_TIMEOUT_MS = 10_000;

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  let res: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    res = await fetch(`${API_URL}/v1/recommendations`, {
      method: "POST",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        "User-Agent": req.headers.get("user-agent") ?? "releases-web",
      }),
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return NextResponse.json({ error: "api_timeout" }, { status: 504 });
    }
    return NextResponse.json({ error: "api_unavailable" }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  const payload = await res.json().catch(() => ({ error: "upstream_error" }));
  return NextResponse.json(payload, { status: res.status });
}
