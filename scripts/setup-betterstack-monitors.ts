#!/usr/bin/env bun
// scripts/setup-betterstack-monitors.ts
//
// Provisions the v1 uptime monitors for the Releases status page in Better Stack
// (Uptime API v2) and attaches them to the existing public status page.
//
// Idempotent: monitors are matched by URL and status-page resources by monitor
// id, so re-running converges the account to the config below instead of
// creating duplicates. Edit MONITORS / COMMON and re-run to update in place.
//
// What it manages:
//   - Web   GET https://releases.sh/                                 (status check)
//   - API   GET https://api.releases.sh/v1/releases/latest?limit=1   (keyword "releases" — exercises D1)
//   - MCP   GET https://mcp.releases.sh/                              (keyword "Releases MCP Server")
//
// It does NOT manage log shipping (Better Stack Telemetry is a separate product
// with its own source token); worker logs already go to Axiom.
//
// Requires: BETTERSTACK_API_KEY = a Better Stack *Uptime* API token (Uptime →
// Settings → API tokens). The repo .env already carries it; from a worktree run
//   set -a; . /path/to/repo/.env; set +a
// first so the var is in the environment.
//
// Run:        bun scripts/setup-betterstack-monitors.ts
// Preview:    bun scripts/setup-betterstack-monitors.ts --dry-run

const API = "https://uptime.betterstack.com/api/v2";
const TOKEN = process.env.BETTERSTACK_API_KEY;
const DRY_RUN = process.argv.includes("--dry-run");

if (!TOKEN) {
  console.error(
    "Missing BETTERSTACK_API_KEY (a Better Stack Uptime API token).\n" +
      "From a worktree: `set -a; . /path/to/repo/.env; set +a` then re-run.",
  );
  process.exit(1);
}

// The public status page these monitors surface on. Resolved by custom domain
// (falling back to subdomain) so this keeps working if the numeric id changes.
const STATUS_PAGE_CUSTOM_DOMAIN = "status.releases.sh";
const STATUS_PAGE_SUBDOMAIN = "releases";

// Shared monitor settings. 3-minute checks from US + EU, email-only alerts
// (no SMS/call/push to avoid surprise charges and keep v1 simple).
const COMMON = {
  check_frequency: 180,
  request_timeout: 30,
  regions: ["us", "eu"],
  email: true,
  sms: false,
  call: false,
  push: false,
  verify_ssl: true,
} as const;

type MonitorSpec = {
  url: string;
  pronounceable_name: string;
  monitor_type: "status" | "keyword";
  required_keyword?: string;
  publicName: string; // label shown on the status page row
};

const MONITORS: MonitorSpec[] = [
  {
    url: "https://releases.sh/",
    pronounceable_name: "Web (releases.sh)",
    monitor_type: "status",
    publicName: "Web",
  },
  {
    // /v1/releases/latest hits D1, so the monitor goes red if the worker is up
    // but the database is failing — unlike the static root index.
    url: "https://api.releases.sh/v1/releases/latest?limit=1",
    pronounceable_name: "API (api.releases.sh)",
    monitor_type: "keyword",
    required_keyword: "releases",
    publicName: "API",
  },
  {
    url: "https://mcp.releases.sh/",
    pronounceable_name: "MCP (mcp.releases.sh)",
    monitor_type: "keyword",
    required_keyword: "Releases MCP Server",
    publicName: "MCP Server",
  },
];

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}\n${text}`);
  }
  return json;
}

// Follow pagination.next, accumulating .data across pages.
async function listAll(path: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = `${API}${path}`;
  while (next) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`GET ${next} → ${res.status}\n${await res.text()}`);
    const json: any = await res.json();
    out.push(...(json.data ?? []));
    next = json.pagination?.next ?? null;
  }
  return out;
}

function monitorBody(m: MonitorSpec) {
  const body: Record<string, unknown> = {
    monitor_type: m.monitor_type,
    url: m.url,
    pronounceable_name: m.pronounceable_name,
    ...COMMON,
  };
  if (m.required_keyword) body.required_keyword = m.required_keyword;
  return body;
}

const norm = (u: string) => u.replace(/\/+$/, "");

async function main() {
  console.log(`Better Stack monitor setup${DRY_RUN ? " (dry-run)" : ""}\n`);

  // 1. Resolve the status page + a section to attach resources under.
  const pages = await listAll("/status-pages");
  const page = pages.find(
    (p) =>
      p.attributes.custom_domain === STATUS_PAGE_CUSTOM_DOMAIN ||
      p.attributes.subdomain === STATUS_PAGE_SUBDOMAIN,
  );
  if (!page) {
    throw new Error(
      `No status page found matching custom_domain=${STATUS_PAGE_CUSTOM_DOMAIN} ` +
        `or subdomain=${STATUS_PAGE_SUBDOMAIN}. Create it in the dashboard first.`,
    );
  }
  const pageId = page.id;
  const publicUrl = page.attributes.custom_domain
    ? `https://${page.attributes.custom_domain}`
    : `https://${page.attributes.subdomain}.betterstack.com`;
  console.log(`Status page: ${page.attributes.company_name} (#${pageId}) → ${publicUrl}`);

  const sections = await listAll(`/status-pages/${pageId}/sections`);
  const section = sections.sort(
    (a, b) => (a.attributes.position ?? 0) - (b.attributes.position ?? 0),
  )[0];
  const sectionId = section?.id;
  console.log(
    section
      ? `Section: "${section.attributes.name}" (#${sectionId})\n`
      : "Section: none found — resources will be attached ungrouped\n",
  );

  // 2. Upsert monitors (match by URL).
  const existingMonitors = await listAll("/monitors");
  const byUrl = new Map<string, any>();
  for (const m of existingMonitors) byUrl.set(norm(m.attributes.url ?? ""), m);

  const resolved: { spec: MonitorSpec; id: string }[] = [];
  for (const spec of MONITORS) {
    const existing = byUrl.get(norm(spec.url));
    if (existing) {
      if (DRY_RUN) {
        console.log(`= would update  ${spec.publicName.padEnd(11)} #${existing.id}  ${spec.url}`);
        resolved.push({ spec, id: existing.id });
      } else {
        await api("PATCH", `/monitors/${existing.id}`, monitorBody(spec));
        console.log(`~ updated       ${spec.publicName.padEnd(11)} #${existing.id}  ${spec.url}`);
        resolved.push({ spec, id: existing.id });
      }
    } else if (DRY_RUN) {
      console.log(`+ would create  ${spec.publicName.padEnd(11)} (new)       ${spec.url}`);
    } else {
      const created = await api("POST", "/monitors", monitorBody(spec));
      const id = created.data.id;
      console.log(`+ created       ${spec.publicName.padEnd(11)} #${id}  ${spec.url}`);
      resolved.push({ spec, id });
    }
  }

  // 3. Attach monitors to the status page (idempotent by monitor id).
  console.log();
  const existingResources = await listAll(`/status-pages/${pageId}/resources`);
  const attached = new Set(
    existingResources
      .filter((r) => r.attributes.resource_type === "Monitor")
      .map((r) => String(r.attributes.resource_id)),
  );

  for (const [i, { spec, id }] of resolved.entries()) {
    if (attached.has(String(id))) {
      console.log(`= already on page  ${spec.publicName}`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`+ would attach     ${spec.publicName} (monitor #${id})`);
      continue;
    }
    const body: Record<string, unknown> = {
      resource_id: Number(id),
      resource_type: "Monitor",
      public_name: spec.publicName,
      position: i,
    };
    if (sectionId) body.status_page_section_id = Number(sectionId);
    await api("POST", `/status-pages/${pageId}/resources`, body);
    console.log(`+ attached         ${spec.publicName} (monitor #${id})`);
  }

  console.log(`\nDone. Status page: ${publicUrl}`);
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
