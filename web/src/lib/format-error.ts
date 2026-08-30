import { NextResponse } from "next/server";
import { ApiNotFoundError } from "@/lib/api";
import { MARKDOWN_404_BODY } from "@/lib/markdown-404";
import type { Format } from "@/lib/request";

/**
 * Map an error thrown by an API-client call into a format-route response.
 *
 * A genuine upstream 404 (`ApiNotFoundError`) becomes `404 not_found`;
 * everything else (503 setup, other 5xx, network failures) becomes
 * `502 bad_gateway` so transient/backend failures aren't misclassified as
 * "not found". Shared by every `app/api/format/**` route.
 *
 * When the caller asked for markdown (`format: "md"`) and this is a genuine
 * 404, the response body is markdown pointing agents at the site's other
 * machine-readable surfaces instead of a JSON error an agent may not parse.
 */
export function formatErrorResponse(
  err: unknown,
  notFoundMessage: string,
  format?: Format,
): NextResponse {
  if (err instanceof ApiNotFoundError) {
    if (format === "md") {
      return new NextResponse(MARKDOWN_404_BODY, {
        status: 404,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }
    return NextResponse.json({ error: "not_found", message: notFoundMessage }, { status: 404 });
  }
  return NextResponse.json(
    { error: "bad_gateway", message: "Upstream API error" },
    { status: 502 },
  );
}
