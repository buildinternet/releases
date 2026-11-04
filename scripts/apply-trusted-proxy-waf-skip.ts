#!/usr/bin/env bun
/**
 * Idempotently add the trusted-proxy WAF skip on the releases.sh zone so Vercel
 * server-to-server calls to api.releases.sh are not edge-challenged.
 *
 * Requires CLOUDFLARE_API_TOKEN (Zone WAF Edit), CLOUDFLARE_ACCOUNT_ID and
 * RELEASES_PROXY_KEY (same value as the API worker secret and the Vercel env).
 * See docs/runbooks/api-trusted-proxy-waf.md.
 *
 * Usage:
 *   bun scripts/apply-trusted-proxy-waf-skip.ts
 *   bun scripts/apply-trusted-proxy-waf-skip.ts --dry-run
 */

const ZONE_NAME = "releases.sh";
const RULE_DESCRIPTION = "Skip bot checks for releases-web trusted proxy";

const PROXY_KEY_RE = /^[A-Za-z0-9._~+/=-]{16,}$/;

/**
 * The skip must match the proxy key's VALUE, not just a non-empty header:
 * both headers are client-settable, so a presence check lets anyone skip the
 * zone's rate limiting, managed rules and bot checks on api.releases.sh.
 * The key lives in the zone's rule config, never in the repo or the logs.
 */
export function buildRuleExpression(proxyKey: string): string {
  // Restricting the alphabet means no escaping, so the literal in the
  // expression is exactly the key and redaction below can't miss it.
  if (!PROXY_KEY_RE.test(proxyKey)) {
    throw new Error(
      "RELEASES_PROXY_KEY must be at least 16 characters of [A-Za-z0-9._~+/=-] to embed in a WAF rule",
    );
  }
  return `(http.host eq "api.releases.sh" and http.request.headers["x-requested-with"][0] eq "releases-web" and http.request.headers["x-releases-proxy-key"][0] eq "${proxyKey}")`;
}

/** Replace the key literal so expressions can be printed safely. */
function redact(expression: string | undefined, proxyKey: string): string | undefined {
  return expression?.split(proxyKey).join("<RELEASES_PROXY_KEY>");
}

const dryRun = process.argv.includes("--dry-run");

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name}.`);
    process.exit(1);
  }
  return v;
}

type CfBody = { success?: boolean; errors?: Array<{ code?: number; message?: string }> };

async function cfRaw(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: CfBody & Record<string, unknown> }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json()) as CfBody & Record<string, unknown>;
  return { status: res.status, body };
}

function fail(method: string, path: string, status: number, body: CfBody) {
  console.error(`Cloudflare API ${method} ${path} failed (${status})`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

type Ruleset = {
  id: string;
  name?: string;
  phase?: string;
  rules?: Array<{
    id?: string;
    description?: string;
    expression?: string;
    action?: string;
    enabled?: boolean;
  }>;
};

const skipRule = (expression: string) => ({
  description: RULE_DESCRIPTION,
  expression,
  action: "skip",
  enabled: true,
  action_parameters: {
    phases: ["http_ratelimit", "http_request_sbfm", "http_request_firewall_managed"],
    products: ["uaBlock", "bic", "hot", "securityLevel"],
  },
});

async function main() {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const proxyKey = requireEnv("RELEASES_PROXY_KEY");
  const expression = buildRuleExpression(proxyKey);
  const printable = (value: unknown) =>
    JSON.stringify(value, null, 2).split(proxyKey).join("<RELEASES_PROXY_KEY>");

  const zonesRes = await cfRaw(token, `/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (!zonesRes.body.success) fail("GET", "/zones", zonesRes.status, zonesRes.body);
  const zone = (zonesRes.body.result as Array<{ id: string; name: string }>)[0];
  if (!zone) {
    console.error(`Zone not found: ${ZONE_NAME}`);
    process.exit(1);
  }
  console.log(`zone: ${zone.name} (${zone.id})`);

  const entryPath = `/zones/${zone.id}/rulesets/phases/http_request_firewall_custom/entrypoint`;
  const entryRes = await cfRaw(token, entryPath);

  if (entryRes.status === 404) {
    const createPayload = {
      name: "zone custom rules",
      kind: "zone",
      phase: "http_request_firewall_custom",
      description: "Custom WAF rules for releases.sh",
      rules: [skipRule(expression)],
    };
    if (dryRun) {
      console.log("dry-run — would create entrypoint ruleset:");
      console.log(printable(createPayload));
      return;
    }
    const created = await cfRaw(token, `/zones/${zone.id}/rulesets`, {
      method: "POST",
      body: JSON.stringify(createPayload),
    });
    if (!created.body.success)
      fail("POST", `/zones/${zone.id}/rulesets`, created.status, created.body);
    const ruleset = created.body.result as Ruleset;
    console.log(`Created entrypoint ruleset ${ruleset.id} with trusted-proxy skip rule`);
    return;
  }

  if (!entryRes.body.success) fail("GET", entryPath, entryRes.status, entryRes.body);

  const ruleset = entryRes.body.result as Ruleset;
  console.log(`custom ruleset: ${ruleset.id} (${ruleset.rules?.length ?? 0} rules)`);

  const existing = ruleset.rules?.find((r) => r.description === RULE_DESCRIPTION);
  if (existing) {
    if (
      existing.expression === expression &&
      existing.action === "skip" &&
      existing.enabled !== false
    ) {
      console.log("Rule already present — no changes needed.");
      return;
    }
    // Typically the older presence-only expression (`... ne ""`): replace it in
    // place so the rule keeps its position above broader challenge rules.
    console.log("Rule exists but differs; updating it in place.");
    console.log(`  current expression: ${redact(existing.expression, proxyKey)}`);
    if (!existing.id) {
      console.error("Existing rule has no id; update it in the dashboard.");
      process.exit(1);
    }
    const rulePath = `/zones/${zone.id}/rulesets/${ruleset.id}/rules/${existing.id}`;
    if (dryRun) {
      console.log("dry-run — would PATCH rule:");
      console.log(printable(skipRule(expression)));
      return;
    }
    const updated = await cfRaw(token, rulePath, {
      method: "PATCH",
      body: JSON.stringify(skipRule(expression)),
    });
    if (!updated.body.success) fail("PATCH", rulePath, updated.status, updated.body);
    console.log(`Updated WAF skip rule ${existing.id}`);
    return;
  }

  const payload = { ...skipRule(expression), position: { index: 1 } };

  if (dryRun) {
    console.log("dry-run — would create rule:");
    console.log(printable(payload));
    return;
  }

  const created = await cfRaw(token, `/zones/${zone.id}/rulesets/${ruleset.id}/rules`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!created.body.success) {
    fail("POST", `/zones/${zone.id}/rulesets/${ruleset.id}/rules`, created.status, created.body);
  }
  const rule = created.body.result as { id: string };
  console.log(`Created WAF skip rule ${rule.id}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
