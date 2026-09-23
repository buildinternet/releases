import { NextRequest, NextResponse } from "next/server";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl, serverApiKey } from "@/lib/env";
import { isAdminViewer } from "@/lib/server-session";

const API_URL = apiBaseUrl() ?? "http://localhost:3456";
const API_SECRET = serverApiKey();

export const dynamic = "force-dynamic";

// Server-side proxy for the admin status dashboard and org fetch-log views.
// Injects the admin Bearer token here so the key never lands in an RSC payload,
// prop, or client bundle. Returns 404 for non-admin callers so the route — which
// forwards with the root key — can't be discovered or abused in production.
async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!(await isAdminViewer())) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { path } = await ctx.params;
  const qs = req.nextUrl.search;
  const url = `${API_URL}/v1/${path.join("/")}${qs}`;

  const extra: Record<string, string> = {};
  if (API_SECRET) extra["Authorization"] = `Bearer ${API_SECRET}`;
  const contentType = req.headers.get("content-type");
  if (contentType) extra["Content-Type"] = contentType;
  const headers = webApiHeaders(extra);

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }

  const res = await fetch(url, init);
  const body = await res.arrayBuffer();
  const responseHeaders = new Headers();
  const upstreamType = res.headers.get("content-type");
  if (upstreamType) responseHeaders.set("content-type", upstreamType);
  // Admin responses must never be cached at the edge.
  responseHeaders.set("cache-control", "private, no-store");
  return new NextResponse(body, { status: res.status, headers: responseHeaders });
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
