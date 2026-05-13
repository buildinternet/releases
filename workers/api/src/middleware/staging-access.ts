import type { MiddlewareHandler } from "hono";
import { getSecret } from "@releases/lib/secrets";

/** Custom header carrying the staging shared secret. */
export const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

/**
 * Interim access gate for the staging hostname. When `STAGING_ACCESS_KEY` is
 * bound (only in `[env.staging]`), every request must carry a matching
 * `X-Releases-Staging-Key` header or receive a 401. CORS preflight is handled
 * earlier by `cors()`, so OPTIONS never reaches this middleware.
 *
 * Holdover until Cloudflare Access is in front of `*-staging.releases.sh`
 * (see issue #444). Skipping the binding in prod/local leaves behavior unchanged.
 */
export function stagingAccessGate(): MiddlewareHandler<{
  Bindings: { STAGING_ACCESS_KEY?: { get(): Promise<string> } };
}> {
  return async (c, next) => {
    if (!c.env.STAGING_ACCESS_KEY) {
      await next();
      return;
    }
    const secret = await getSecret(c.env.STAGING_ACCESS_KEY);
    if (!secret) {
      await next();
      return;
    }
    if (c.req.header(STAGING_KEY_HEADER) !== secret) {
      return c.json(
        { error: "unauthorized", message: "Missing or invalid staging access key" },
        401,
      );
    }
    await next();
  };
}
