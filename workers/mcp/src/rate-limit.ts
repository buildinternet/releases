import { logEvent } from "@releases/lib/log-event";
import { flag, FLAGS } from "@releases/lib/flags";
import {
  resolveTierEnforcement,
  rateLimitConsumerRef,
  rateLimitDecisionPayload,
  classifyTokenId,
  accountBucketKey,
  policyHeader,
  RATE_LIMITED_ERROR,
  selectTierLimiters,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitPrincipal,
} from "@releases/lib/rate-limit-tiers";
import type { McpIdentity } from "./auth.js";
import type { Env } from "./mcp-agent.js";

/**
 * Classify a resolved MCP identity into a rate-limit principal.
 *
 * Tier mapping:
 *   root          → exempt (static root key bypasses all limits)
 *   token (oauth_) → account (bucketed on the userId = `<sub>`, prefix stripped, so a
 *                             user's OAuth + API-key traffic share one per-account budget)
 *   token (relu_)  → account (bucketed on tokenId = `relu_<keyId>`, one bucket PER KEY —
 *                             MCP's /tokens/me introspection returns the key id, not the owner
 *                             userId, so per-account bucketing isn't available here; see
 *                             accountBucketKey in @releases/lib/rate-limit-tiers)
 *   token (relk_)  → machine (bucketed on tokenId)
 *   anonymous     → anonymous (bucketed on the caller IP)
 */
export function mcpPrincipal(identity: McpIdentity, ip: string): RateLimitPrincipal {
  if (identity.kind === "root") return { tier: "exempt" };
  if (identity.kind === "token") {
    const id = identity.tokenId;
    const tier = classifyTokenId(id);
    return { tier, bucketKey: tier === "account" ? accountBucketKey(id) : id };
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
  const rateLimitEnabled = await flag(env.FLAGS, env.RATE_LIMIT_ENABLED, FLAGS.rateLimitEnabled);
  const limiters = selectTierLimiters(rateLimitEnabled, env.TOKEN_RATE_LIMIT_ENABLED === "true", {
    anonymous: env.PUBLIC_RATE_LIMITER,
    account: env.USER_RATE_LIMITER,
    machine: env.TOKEN_RATE_LIMITER,
  });
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
  return new Response(JSON.stringify(RATE_LIMITED_ERROR), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS),
      "RateLimit-Policy": policyHeader(plan.policyName, plan.quota),
    },
  });
}
