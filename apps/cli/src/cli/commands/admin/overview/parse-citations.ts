import { type OverviewCitation } from "../../../../api/types.js";

export class ParseCitationsError extends Error {}

/**
 * Parse a citations JSON file. Shape mirrors the wire contract:
 * `[{ startIndex, endIndex, sourceUrl, title?, citedText }, ...]`. The API
 * worker validates and rejects bad spans with `400 bad_citations`, but failing
 * client-side keeps the error message close to the offending file.
 *
 * Throws `ParseCitationsError` with a single-line message — the CLI command
 * surface logs and exits 1; tests assert the message.
 */
export function parseCitationsJson(raw: string, source: string): OverviewCitation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ParseCitationsError(
      `citations-file ${source}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ParseCitationsError(`citations-file ${source}: expected a JSON array`);
  }
  const out: OverviewCitation[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const c = parsed[i] as Partial<OverviewCitation> | null;
    if (!c || typeof c !== "object") {
      throw new ParseCitationsError(`citations-file ${source}: citations[${i}] must be an object`);
    }
    if (typeof c.startIndex !== "number" || typeof c.endIndex !== "number") {
      throw new ParseCitationsError(
        `citations-file ${source}: citations[${i}] missing numeric startIndex/endIndex`,
      );
    }
    if (typeof c.sourceUrl !== "string" || !c.sourceUrl) {
      throw new ParseCitationsError(`citations-file ${source}: citations[${i}] missing sourceUrl`);
    }
    if (typeof c.citedText !== "string" || !c.citedText) {
      throw new ParseCitationsError(`citations-file ${source}: citations[${i}] missing citedText`);
    }
    out.push({
      startIndex: c.startIndex,
      endIndex: c.endIndex,
      sourceUrl: c.sourceUrl,
      title: typeof c.title === "string" ? c.title : null,
      citedText: c.citedText,
    });
  }
  return out;
}
