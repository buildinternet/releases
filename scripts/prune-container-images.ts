/**
 * Prune stale tags from the `releases-discovery-sandbox` managed-registry
 * repository (the discovery worker's `Sandbox` container image).
 *
 * Why: `workers/discovery/wrangler.jsonc` builds the image from a Dockerfile,
 * so every `wrangler deploy` pushes a fresh tag. Nothing removes old ones, and
 * Cloudflare caps managed-registry storage at 50 GB per ACCOUNT (a hard limit —
 * pushes fail account-wide past it). The account is shared with Sunny, so this
 * repo filling up breaks Sunny's deploys too.
 *
 * Keep policy (see docs/architecture/deploy-coupling.md → "Container image
 * retention"): for each environment (prod, staging) keep the tag of the
 * currently deployed Worker version plus the previous `--keep` (default 5)
 * deployed versions, so `wrangler rollback` to any of them still works.
 * Everything else in the repo is deleted.
 *
 * How tags map to versions: wrangler tags a Dockerfile-built image with the
 * first 8 hex chars of the Worker VERSION id it deploys. `wrangler versions
 * view --json` / `deployments list --json` never expose the image reference, so
 * that prefix is the only link — this script derives the keep set from
 * `wrangler deployments list --json` version ids, then PROVES the mapping before
 * deleting anything: it resolves each live app's configured image digest
 * (`wrangler containers info`) and checks it equals the registry digest of the
 * kept "current" tag. Any mismatch aborts.
 *
 * Trust boundary: `wrangler containers images list --json` is the ONLY
 * exists/doesn't-exist oracle. The registry's own `/v2/.../tags/list` is
 * paginated and under-reports; `docker manifest inspect` returns `unauthorized`
 * once the short-lived login expires, which looks like "missing". Neither is
 * used to pick deletion candidates.
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=… bun scripts/prune-container-images.ts             # dry run (default)
 *   CLOUDFLARE_ACCOUNT_ID=… bun scripts/prune-container-images.ts --keep 5 --yes
 *
 * Never touches any other repository (`sunny-render*`, the staging repo, …).
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const IMAGE_REPO = "releases-discovery-sandbox";
const WRANGLER_CONFIG = join(import.meta.dir, "../workers/discovery/wrangler.jsonc");

/** Container apps whose configured image must map onto a kept tag. */
export const ENVIRONMENTS = [
  { label: "prod", app: "releases-discovery-sandbox", flags: [] as string[] },
  {
    label: "staging",
    app: "releases-discovery-staging-sandbox-staging",
    flags: ["--env", "staging"],
  },
];

/** Tag wrangler assigns to a Dockerfile-built image for a Worker version. */
export function tagForVersionId(versionId: string): string {
  return versionId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

/**
 * Deployed version ids, newest first, from a `wrangler deployments list --json`
 * payload (which wrangler emits oldest-first). Only versions actually serving
 * traffic (percentage > 0) count as rollback targets.
 */
export function deployedVersionIds(deployments: unknown): string[] {
  const rows = Array.isArray(deployments) ? deployments : [];
  const ids: string[] = [];
  for (const d of rows as Array<{
    versions?: Array<{ version_id?: string; percentage?: number }>;
  }>) {
    for (const v of d.versions ?? []) {
      if (v.version_id && (v.percentage ?? 100) > 0) ids.push(v.version_id);
    }
  }
  // De-dup while preserving order, then newest first.
  return [...new Set(ids)].reverse();
}

/** Keep the current tag plus the previous `keep` deployed tags for one env. Pure. */
export function keepTagsForEnv(
  versionIds: string[],
  keep: number,
): { current: string | null; tags: string[] } {
  const tags = [...new Set(versionIds.map(tagForVersionId))].slice(0, keep + 1);
  return { current: tags[0] ?? null, tags };
}

/** Union of per-env keep tags. Pure. */
export function buildKeepSet(perEnvTags: string[][]): Set<string> {
  const keep = new Set<string>();
  for (const tags of perEnvTags) for (const t of tags) keep.add(t);
  return keep;
}

export type PlanRow = { tag: string; action: "keep" | "delete"; reason: string };

/** Decide keep/delete for each registry tag. Pure; sorted by tag. */
export function planPrune(candidateTags: string[], keepSet: Set<string>): PlanRow[] {
  return [...new Set(candidateTags)].sort().map((tag) => ({
    tag,
    action: keepSet.has(tag) ? "keep" : "delete",
    reason: keepSet.has(tag) ? "in keep set" : "not a current or recent deployed version",
  }));
}

/**
 * Find the repo entry in `wrangler containers images list --json`. Returns
 * `null` when the repo is absent from the listing — callers must treat that as
 * "listing not trustworthy for this repo", never as "zero images" (the staging
 * repo, for instance, exists in the registry but is missing from the listing).
 */
export function findRepoEntry(listing: unknown, repo: string): { tags: string[] } | null {
  const rows = Array.isArray(listing) ? (listing as Array<Record<string, unknown>>) : [];
  const grouped = rows.find((r) => r && r.name === repo);
  if (grouped) return { tags: [...new Set((grouped.tags as string[] | undefined) ?? [])] };
  return null;
}

/** Extract the `@sha256:…` digest from a container app's configured image. */
export function digestFromImageRef(image: string | undefined): string | null {
  const m = /@(sha256:[a-f0-9]{64})$/.exec(image ?? "");
  return m ? m[1]! : null;
}

export function parseArgs(argv: string[]): { keep: number; yes: boolean } {
  let keep = 5;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") {
      keep = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(keep) || keep < 0)
        throw new Error(`--keep must be a non-negative integer`);
    } else if (a === "--yes") yes = true;
    else if (a === "--dry-run") {
      /* default */
    } else throw new Error(`Unknown flag: ${a}`);
  }
  return { keep, yes };
}

// ---------------------------------------------------------------------------
// I/O (everything below shells out; the logic above is pure and unit-tested)
// ---------------------------------------------------------------------------

function wrangler(args: string[], opts: { timeoutMs?: number; inherit?: boolean } = {}): string {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "inherit"],
    timeout: opts.timeoutMs ?? 60_000,
    env: process.env,
  });
}

function wranglerJson<T = unknown>(args: string[]): T {
  return JSON.parse(wrangler([...args, "--json"])) as T;
}

/** Registry digest for `repo:tag` via a short-lived pull credential. */
async function registryDigest(
  creds: { registry_host: string; account_id: string; username: string; password: string },
  repo: string,
  tag: string,
): Promise<string | null> {
  const url = `https://${creds.registry_host}/v2/${creds.account_id}/${repo}/manifests/${tag}`;
  const res = await fetch(url, {
    method: "HEAD",
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`,
      Accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
      ].join(","),
    },
  });
  if (!res.ok) return null;
  return res.headers.get("docker-content-digest");
}

async function main(): Promise<void> {
  const { keep, yes } = parseArgs(process.argv.slice(2));
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error(
      "prune-container-images: set CLOUDFLARE_ACCOUNT_ID (the account is shared; pin it explicitly).",
    );
    process.exit(2);
  }

  // 1. Keep set from deployed Worker versions.
  const perEnv: Array<{ label: string; app: string; current: string | null; tags: string[] }> = [];
  for (const env of ENVIRONMENTS) {
    const deployments = wranglerJson([
      "deployments",
      "list",
      "--config",
      WRANGLER_CONFIG,
      ...env.flags,
    ]);
    const { current, tags } = keepTagsForEnv(deployedVersionIds(deployments), keep);
    if (!current) {
      console.error(
        `prune-container-images: ${env.label} has no deployed versions — refusing to continue.`,
      );
      process.exit(1);
    }
    perEnv.push({ label: env.label, app: env.app, current, tags });
    console.log(`${env.label}: current ${current}, keeping ${tags.join(", ")}`);
  }
  const keepSet = buildKeepSet(perEnv.map((e) => e.tags));

  // 2. Prove the version-id → tag mapping against each live app's digest.
  //    Only prod's app points at IMAGE_REPO; staging's app points at its own
  //    repo, so verify it there (same tag scheme) without ever pruning it.
  const apps = wranglerJson<Array<{ id: string; name: string }>>(["containers", "list"]);
  const creds = wranglerJson<{
    registry_host: string;
    account_id: string;
    username: string;
    password: string;
  }>(["containers", "registries", "credentials", "--pull"]);
  for (const env of perEnv) {
    const app = apps.find((a) => a.name === env.app);
    if (!app) {
      console.error(
        `prune-container-images: container app ${env.app} not found — refusing to continue.`,
      );
      process.exit(1);
    }
    const info = wranglerJson<{ configuration?: { image?: string } }>([
      "containers",
      "info",
      app.id,
    ]);
    const liveDigest = digestFromImageRef(info.configuration?.image);
    const repoOfApp = /\/([^/@:]+)[@:][^/]*$/.exec(info.configuration?.image ?? "")?.[1] ?? "";
    const tagDigest = await registryDigest(creds, repoOfApp, env.current!);
    if (!liveDigest || !tagDigest || liveDigest !== tagDigest) {
      console.error(
        `prune-container-images: ${env.label} app image digest (${liveDigest ?? "?"}) does not match registry digest of tag ${repoOfApp}:${env.current} (${tagDigest ?? "?"}). The version-id → tag assumption no longer holds; refusing to delete anything.`,
      );
      process.exit(1);
    }
    console.log(`${env.label}: live image digest matches ${repoOfApp}:${env.current} ✓`);
  }

  // 3. Candidates from the only trustworthy listing.
  const listing = wranglerJson(["containers", "images", "list"]);
  const entry = findRepoEntry(listing, IMAGE_REPO);
  if (!entry) {
    console.error(
      `prune-container-images: \`wrangler containers images list\` has no entry for ${IMAGE_REPO}; refusing to delete anything.`,
    );
    process.exit(1);
  }
  const plan = planPrune(entry.tags, keepSet);
  const deletes = plan.filter((p) => p.action === "delete");
  const missingKeep = [...keepSet].filter((t) => !entry.tags.includes(t));

  console.log(`\nkeep set (${keepSet.size}): ${[...keepSet].sort().join(", ")}`);
  if (missingKeep.length)
    console.log(
      `(not in ${IMAGE_REPO} — staging tags live in their own repo): ${missingKeep.join(", ")}`,
    );
  console.log(
    `\n${IMAGE_REPO}: ${plan.length} tags, ${plan.length - deletes.length} keep / ${deletes.length} delete`,
  );
  for (const row of plan.filter((p) => p.action === "keep"))
    console.log(`  keep    ${row.tag}  ${row.reason}`);
  console.log(`  delete  ${deletes.map((d) => d.tag).join(" ")}`);

  if (!yes) {
    console.log(
      `\ndry run — ${deletes.length} tag(s) would be deleted. Re-run with --yes to delete.`,
    );
    return;
  }
  let done = 0;
  for (const row of deletes) {
    const ref = `${IMAGE_REPO}:${row.tag}`;
    try {
      wrangler(["containers", "images", "delete", ref, "--skip-confirmation"], { inherit: true });
      done++;
    } catch (err) {
      console.error(`prune-container-images: failed to delete ${ref}: ${String(err)}`);
    }
  }
  console.log(`\ndeleted ${done}/${deletes.length} tag(s).`);
  if (done !== deletes.length) process.exit(1);
}

if (import.meta.main) {
  await main();
}
