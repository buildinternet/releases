import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";

/**
 * Parse a JSON request body, tolerating a legitimately-absent body (returns
 * `{}`) but rejecting a body that was sent and failed to parse (400) — so a
 * malformed payload can never silently default to a benign-looking value.
 */
export async function parseJsonBody<T>(c: Context): Promise<T> {
  const raw = await c.req.text();
  if (raw.trim() === "") return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

/**
 * Result of {@link readJsonBodyCapped}. `status` mirrors the intended HTTP
 * status (413/400), but callers typically map `error` → an error `code` and let
 * the standardized envelope normalize the status.
 */
export type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400; error: "invalid_json" }
  | { ok: false; status: 413; error: "payload_too_large" };

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read + parse a JSON request body while **enforcing** a byte cap by streaming
 * the body and summing chunk sizes — the only guard that actually holds, since a
 * `Content-Length` header check is advisory (a chunked or header-spoofed request
 * sails past it). Bails at `maxBytes` with `payload_too_large`, cancelling the
 * reader so we never buffer the whole payload. A missing body, a read error, or
 * unparseable bytes all resolve to `invalid_json`. Shared by the open,
 * unauthenticated POST routes (`/feedback`, `/recommendations`); keep the cheap
 * `Content-Length` pre-check at the call site as a fast-path for honest clients.
 */
export async function readJsonBodyCapped(
  req: Request,
  maxBytes: number,
): Promise<ReadJsonBodyResult> {
  if (!req.body) {
    return { ok: false, status: 400, error: "invalid_json" };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- request streams must be consumed sequentially
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: "payload_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }

  try {
    const text = new TextDecoder().decode(concatChunks(chunks, total));
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}
