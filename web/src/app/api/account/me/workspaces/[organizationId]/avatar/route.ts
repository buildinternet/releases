import type { NextRequest } from "next/server";
import { isAccountOrganizationId } from "@/lib/account-organization-id";
import { ACCOUNT_AVATAR_PROXY_MAX_BYTES, forwardAccountApi } from "@/lib/account-api-proxy";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await ctx.params;
  if (!isAccountOrganizationId(organizationId)) {
    return Response.json(
      { error: "bad_request", message: "Invalid workspace id" },
      { status: 400 },
    );
  }

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

  return forwardAccountApi("POST", `/v1/me/workspaces/${organizationId}/avatar`, {
    body,
    contentType: req.headers.get("content-type"),
  });
}
