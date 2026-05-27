import { NextResponse } from "next/server";
import { ApiNotFoundError } from "@/lib/api";

/**
 * Map an error thrown by an API-client call into a format-route response.
 *
 * A genuine upstream 404 (`ApiNotFoundError`) becomes `404 not_found`;
 * everything else (503 setup, other 5xx, network failures) becomes
 * `502 bad_gateway` so transient/backend failures aren't misclassified as
 * "not found". Shared by every `app/api/format/**` route.
 */
export function formatErrorResponse(err: unknown, notFoundMessage: string): NextResponse {
  if (err instanceof ApiNotFoundError) {
    return NextResponse.json({ error: "not_found", message: notFoundMessage }, { status: 404 });
  }
  return NextResponse.json(
    { error: "bad_gateway", message: "Upstream API error" },
    { status: 502 },
  );
}
