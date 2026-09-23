import type { NextRequest } from "next/server";
import { ACCOUNT_AVATAR_PROXY_MAX_BYTES, forwardAccountApi } from "@/lib/account-api-proxy";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.arrayBuffer();
  if (body.byteLength > ACCOUNT_AVATAR_PROXY_MAX_BYTES) {
    return Response.json(
      {
        error: "too_large",
        message: `Image exceeds the ${ACCOUNT_AVATAR_PROXY_MAX_BYTES}-byte upload cap`,
      },
      { status: 413 },
    );
  }
  return forwardAccountApi("POST", "/v1/me/avatar", {
    body,
    contentType: req.headers.get("content-type"),
  });
}
