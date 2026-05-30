/**
 * Normalize a release's `media` field to a JSON string safe to bind to D1.
 *
 * `POST /v1/sources/:id/releases/batch` documents `media` as a JSON string, but
 * a misbehaving caller (or LLM agent) may send an array/object. Binding a
 * non-primitive makes D1 reject the prepared statement; because the batch insert
 * is chunked + non-transactional, that 500s mid-batch after partially inserting
 * earlier chunks. Coercing here (stringify the array/object) keeps the insert
 * forgiving instead of silently half-applying.
 */
export function normalizeMediaBind(media: unknown): string {
  if (typeof media === "string") return media;
  if (media == null) return "[]";
  return JSON.stringify(media);
}
