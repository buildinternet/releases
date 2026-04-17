import { NextRequest } from "next/server";

export const FORMATS = ["json", "md", "atom"] as const;
export type Format = (typeof FORMATS)[number];

function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}

/** Read the requested output format from the proxy header or query param. */
export function getFormat(request: NextRequest): Format {
  const raw =
    request.nextUrl.searchParams.get("format") ??
    request.headers.get("x-format") ??
    "json";
  return isFormat(raw) ? raw : "json";
}
