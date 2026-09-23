/**
 * Normalize a release's `media` field to a JSON string safe to bind to D1.
 *
 * `POST /v1/sources/:id/releases/batch` documents `media` as a JSON string, but
 * a misbehaving caller (or LLM agent) may send an array/object. Binding a
 * non-primitive makes D1 reject the prepared statement; because the batch insert
 * is chunked + non-transactional, that 500s mid-batch after partially inserting
 * earlier chunks. Coercing here (stringify the array/object) keeps the insert
 * forgiving instead of silently half-applying.
 *
 * Special case: a plain URL string (e.g. `"https://cdn.example.com/shot.png"`)
 * is NOT valid stored media — `parseReleaseMedia` expects a JSON array of media
 * objects and silently returns `[]` for non-array JSON. Wrap plain URLs in the
 * canonical `[{ type, url }]` shape so they survive the read-time parse.
 */
export function normalizeMediaBind(media: unknown): string {
  if (typeof media === "string") {
    // Fast-path: if the string parses as a JSON array it's already correct.
    let parsed: unknown;
    try {
      parsed = JSON.parse(media);
    } catch {
      // Not JSON — treat as a plain URL and wrap it in the canonical shape.
      return JSON.stringify([{ type: "image", url: media }]);
    }
    if (Array.isArray(parsed)) return media;
    // Parsed as a JSON string (double-quoted URL), object, number, or null —
    // none of these is valid stored media. A JSON-quoted string may be a URL
    // (e.g. `"\"https://x/a.png\""`), so unwrap it; everything else falls back
    // to empty.
    if (typeof parsed === "string" && parsed.length > 0) {
      return JSON.stringify([{ type: "image", url: parsed }]);
    }
    return "[]";
  }
  if (media == null) return "[]";
  return JSON.stringify(media);
}
