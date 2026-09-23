import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { statusToType } from "@buildinternet/releases-core/errors";
import {
  isReleasesError,
  ReleasesError,
  ValidationError,
  InternalError,
} from "@releases/lib/releases-error";
import { classifyDbError, dbErrorToWireCode } from "@releases/lib/db-errors";
import { logEvent } from "@releases/lib/log-event";
import { BareSlugRejected } from "../utils";

/**
 * The API's single error producer. Maps any thrown value to the standardized
 * nested envelope (`{ error: { code, type, message, details? } }`) and the right
 * HTTP status. Registered as `app.onError` (see index.ts). Cascade order matters:
 * typed domain errors first, then the two framework/legacy shapes, then a
 * classified D1 failure, then the generic fallback.
 */
export function respondError(c: Context, err: unknown): Response {
  // 1. Typed domain error — trust its code/type/status.
  if (isReleasesError(err)) {
    return c.json(err.toWire(), err.status as ContentfulStatusCode);
  }

  // 2. Legacy bare-slug rejection (thrown by the source/product resolvers).
  if (err instanceof BareSlugRejected) {
    const e = new ValidationError(err.message, {
      code: "bare_slug_rejected",
      details: { entity: err.entity },
    });
    return c.json(e.toWire(), e.status as ContentfulStatusCode);
  }

  // 3. Hono HTTPException — preserve its status and any attached headers
  //    (Retry-After, Set-Cookie, …); shape the envelope from the status.
  if (err instanceof HTTPException) {
    const type = statusToType(err.status);
    // Fail closed on server-class statuses: only a client-side (4xx) HTTPException
    // may surface its own message. A 5xx (including unmapped statuses, which
    // `statusToType` maps to `internal`) gets the generic message so an internal
    // detail carried on the exception can't leak to the client.
    const expose = err.status < 500;
    const wire = new ReleasesError(type, err.message, {
      code: err.status === 400 ? "invalid_json" : undefined,
      expose,
    }).toWire();
    const res = c.json(wire, err.status);
    if (err.res) {
      err.res.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        // c.json sets content-type/content-length itself.
        if (lower !== "content-type" && lower !== "content-length") {
          res.headers.append(key, value);
        }
      });
    }
    return res;
  }

  // 4. Classified D1 failure — attach the diagnostic (fixes the "only ~4 routes
  //    expose errorCode" gap: now every route surfaces it via the boundary).
  const db = classifyDbError(err);
  if (db) {
    logEvent("error", {
      component: "api",
      event: "db_error",
      causeCode: db.code,
      causeTransient: db.transient,
    });
    const e = new InternalError("Internal server error", {
      code: dbErrorToWireCode(db.code),
      details: { dbCode: db.code, transient: db.transient },
    });
    return c.json(e.toWire(), e.status as ContentfulStatusCode);
  }

  // 5. Unexpected — generic 500, real message logged but never sent.
  const detail = err instanceof Error ? err.message : String(err);
  logEvent("error", { component: "api", event: "unhandled_error", error: detail });
  const e = new InternalError();
  return c.json(e.toWire(), e.status as ContentfulStatusCode);
}
