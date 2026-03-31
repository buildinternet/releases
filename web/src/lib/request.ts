import { NextRequest } from "next/server";

/** Read the requested output format from the proxy header or query param. */
export function getFormat(request: NextRequest): string {
  return (
    request.nextUrl.searchParams.get("format") ??
    request.headers.get("x-format") ??
    "json"
  );
}
