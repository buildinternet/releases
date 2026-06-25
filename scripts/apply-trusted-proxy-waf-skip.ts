#!/usr/bin/env bun
/**
 * Idempotently add the trusted-proxy WAF skip on the releases.sh zone so Vercel
 * server-to-server calls to api.releases.sh are not edge-challenged.
 *
 * Requires CLOUDFLARE_API_TOKEN (Zone WAF Edit) and CLOUDFLARE_ACCOUNT_ID.
 * See docs/runbooks/api-trusted-proxy-waf.md.
 *
 * Usage:
 *   bun scripts/apply-trusted-proxy-waf-skip.ts
 *   bun scripts/apply-trusted-proxy-waf-skip.ts --dry-run
 */

const ZONE_NAME = "releases.sh";
const RULE_DESCRIPTION = "Skip bot checks for releases-web trusted proxy";
const RULE_EXPRESSION = `(http.host eq "api.releases.sh" and http.request.headers["x-requested-with"][0] eq "releases-web" and http.request.headers["x-releases-proxy-key"][0] ne "")`;

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

const skipRule = () => ({
  description: RULE_DESCRIPTION,
  expression: RULE_EXPRESSION,
  action: "skip",
  enabled: true,
  action_parameters: {
    phases: ["http_request_sbfm"],
    products: ["bic", "securityLevel"],
  },
});

async function main() {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");

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
      rules: [skipRule()],
    };
    if (dryRun) {
      console.log("dry-run — would create entrypoint ruleset:");
      console.log(JSON.stringify(createPayload, null, 2));
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
      existing.expression === RULE_EXPRESSION &&
      existing.action === "skip" &&
      existing.enabled !== false
    ) {
      console.log("Rule already present — no changes needed.");
      return;
    }
    console.log("Rule exists but differs; update via dashboard or delete and re-run.");
    console.log(JSON.stringify(existing, null, 2));
    process.exit(1);
  }

  const payload = { ...skipRule(), position: { index: 1 } };

  if (dryRun) {
    console.log("dry-run — would create rule:");
    console.log(JSON.stringify(payload, null, 2));
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
