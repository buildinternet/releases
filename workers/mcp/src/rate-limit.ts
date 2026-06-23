import { logEvent } from "@releases/lib/log-event";
import { flag, FLAGS } from "@releases/lib/flags";
import { OAUTH_JWT_TOKEN_PREFIX } from "@releases/lib/consumption-ref";
import { isUserApiKeyShaped } from "@buildinternet/releases-core/api-token";
import {
  resolveTierEnforcement,
  rateLimitConsumerRef,
  rateLimitDecisionPayload,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitPrincipal,
  type TierLimiters,
} from "@releases/lib/rate-limit-tiers";
import type { McpIdentity } from "./auth.js";
import type { Env } from "./mcp-agent.js";

/**
 * Classify a resolved MCP identity into a rate-limit principal.
 *
 * Tier mapping:
 *   root          → exempt (static root key bypasses all limits)
 *   token (oauth_) → account (bucketed on tokenId = `oauth_<sub>`, one bucket per JWT subject)
 *   token (relu_)  → account (bucketed on tokenId = `relu_<keyId>`, one bucket per user key —
 *                             acceptable per-key granularity; no credential cache needed because
 *                             identity is pre-resolved by resolveMcpAuth)
 *   token (relk_)  → machine (bucketed on tokenId)
 *   anonymous     → anonymous (bucketed on the caller IP)
 */
export function mcpPrincipal(identity: McpIdentity, ip: string): RateLimitPrincipal {
  if (identity.kind === "root") return { tier: "exempt" };
  if (identity.kind === "token") {
    const id = identity.tokenId;
    // OAuth JWT: tokenId is `oauth_<sub>` — one bucket per authenticated user subject.
    if (id.startsWith(OAUTH_JWT_TOKEN_PREFIX)) return { tier: "account", bucketKey: id };
    // relu_ user key: userToken or tokenId carries the `relu_` prefix.
    if (isUserApiKeyShaped(identity.userToken ?? "") || isUserApiKeyShaped(id))
      return { tier: "account", bucketKey: id };
    // relk_ machine token (or any other token).
    return { tier: "machine", bucketKey: id };
  }
  // anonymous
  return { tier: "anonymous", bucketKey: ip };
}

/**
 * Enforce the three-rung rate limiter for an MCP request.
 *
 * Returns a 429 Response when over quota, else null. No credential cache is
 * needed here — `resolveMcpAuth` already resolved the identity before this runs,
 * so we map the pre-resolved identity straight to a tier with no extra KV lookup.
 *
 * account + anonymous rungs gate on RATE_LIMIT_ENABLED.
 * machine rung gates on TOKEN_RATE_LIMIT_ENABLED.
 */
export async function enforceMcpRateLimit(
  request: Request,
  env: Env,
  identity: McpIdentity,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const ipEnabled = await flag(env.FLAGS, env.RATE_LIMIT_ENABLED, FLAGS.rateLimitEnabled);
  const limiters: TierLimiters = {
    anonymous: ipEnabled ? env.PUBLIC_RATE_LIMITER : undefined,
    account: ipEnabled ? env.USER_RATE_LIMITER : undefined,
    machine: env.TOKEN_RATE_LIMIT_ENABLED === "true" ? env.TOKEN_RATE_LIMITER : undefined,
  };
  if (!limiters.anonymous && !limiters.account && !limiters.machine) return null;

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const plan = resolveTierEnforcement(mcpPrincipal(identity, ip), limiters);
  if (!plan || !plan.limiter) return null;

  const { success } = await plan.limiter.limit({ key: plan.key });

  const emit = (async () => {
    logEvent("info", {
      ...rateLimitDecisionPayload({
        surface: "mcp",
        tier: plan.tier,
        rateLimited: !success,
        consumerRef: await rateLimitConsumerRef(plan.key),
        operation: "mcp",
      }),
    });
  })();
  try {
    ctx.waitUntil(emit);
  } catch {
    await emit;
  }

  if (success) return null;
  return new Response(
    JSON.stringify({ error: "rate_limited", message: "Too many requests. Please retry shortly." }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS),
        "RateLimit-Policy": `"${plan.policyName}";q=${plan.quota};w=${RATE_LIMIT_WINDOW_SECONDS}`,
      },
    },
  );
}
