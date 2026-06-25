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

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json()) as T & { success?: boolean; errors?: unknown };
  if (!res.ok || body.success === false) {
    console.error(`Cloudflare API ${init.method ?? "GET"} ${path} failed (${res.status})`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
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

async function main() {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");

  const zones = await cf<{ result: Array<{ id: string; name: string }> }>(
    token,
    `/zones?name=${encodeURIComponent(ZONE_NAME)}`,
  );
  const zone = zones.result[0];
  if (!zone) {
    console.error(`Zone not found: ${ZONE_NAME}`);
    process.exit(1);
  }
  console.log(`zone: ${zone.name} (${zone.id})`);

  const entry = await cf<{ result: Ruleset }>(
    token,
    `/zones/${zone.id}/rulesets/phases/http_request_firewall_custom/entrypoint`,
  );
  const ruleset = entry.result;
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

  const payload = {
    description: RULE_DESCRIPTION,
    expression: RULE_EXPRESSION,
    action: "skip",
    enabled: true,
    position: { index: 1 },
    action_parameters: {
      phases: ["http_request_sbfm"],
      products: ["bic", "securityLevel"],
    },
  };

  if (dryRun) {
    console.log("dry-run — would create rule:");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const created = await cf<{ result: { id: string } }>(
    token,
    `/zones/${zone.id}/rulesets/${ruleset.id}/rules`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  console.log(`Created WAF skip rule ${created.result.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
