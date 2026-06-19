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
