import { NextRequest, NextResponse } from "next/server";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "@/lib/env";

const API_URL = apiBaseUrl() ?? "http://localhost:3456";
const UPSTREAM_TIMEOUT_MS = 10_000;

export const dynamic = "force-dynamic";

/** Flatten worker `{ error: { code } }` (or legacy `{ error: string }`) to a flat code. */
function readErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const err = (payload as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Browser → Next → open `POST /v1/feedback` (mirrors `/api/recommendations`). */
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
    res = await fetch(`${API_URL}/v1/feedback`, {
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

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    return NextResponse.json(
      { error: readErrorCode(payload) ?? "upstream_error" },
      { status: res.status },
    );
  }
  return NextResponse.json(payload ?? {}, { status: res.status });
}
