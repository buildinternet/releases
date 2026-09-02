/**
 * Prune stale tags from the `releases-discovery-sandbox` managed-registry
 * repository (the discovery worker's `Sandbox` container image).
 *
 * Why: before #2261, `workers/discovery/wrangler.jsonc` built the image from a
 * Dockerfile, so every `wrangler deploy` pushed a fresh tag. Nothing removed
 * old ones, and Cloudflare caps managed-registry storage at 50 GB per ACCOUNT
 * (a hard limit — pushes fail account-wide past it). The account is shared
 * with Sunny, so this repo filling up breaks Sunny's deploys too.
 *
 * #2261 pinned `containers[].image` to a content-hash tag
 * (scripts/discovery-container-image.ts) so a deploy no longer pushes a new
 * tag unless the image's real inputs changed. This script now runs during the
 * transition: old images are still tagged with a Worker-version-id prefix,
 * new ones with the content-hash tag pinned in wrangler.jsonc.
 *
 * Keep policy (see docs/architecture/deploy-coupling.md → "Container image
 * retention"): the union of —
 *   1. the content-hash tag currently pinned in `workers/discovery/wrangler.jsonc`
 *      in the working tree (what a deploy right now would need), and
 *   2. the pinned tag at each of the last `--keep` commits on `origin/main`
 *      that touched that file (so `wrangler rollback` to a recent deploy still
 *      resolves an image that's still in the registry), and
 *   3. for the version-id era: the currently deployed Worker version's tag
 *      plus the previous `--keep` deployed versions, per environment.
 * Everything else in the repo is deleted.
 *
 * How version-id tags map to versions: wrangler tagged a Dockerfile-built
 * image with the first 8 hex chars of the Worker VERSION id it deployed.
 * `wrangler versions view --json` / `deployments list --json` never expose the
 * image reference, so that prefix was the only link for the version-id era —
 * this script derives that half of the keep set from `wrangler deployments
 * list --json` version ids, then PROVES the mapping before deleting anything:
 * it resolves each live app's configured image digest (`wrangler containers
 * info`) and checks it equals the registry digest of SOME tag in that env's
 * keep set (the content-hash tag once redeployed post-#2261, or still the
 * version-id tag until then). Any mismatch aborts.
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
 *   CLOUDFLARE_ACCOUNT_ID=… bun scripts/prune-container-images.ts --repo releases-discovery-staging-sandbox-staging
 *
 * `--repo` (default `releases-discovery-sandbox`) selects which Releases repo
 * to prune. It only accepts repos in PRUNABLE_REPOS; when it isn't the default
 * repo the script additionally requires that NO live container app references
 * it (the staging repo is orphaned since #2261 — staging pulls from the prod
 * repo), and still keeps that env's recent version-id tags for rollback.
 * `sunny-render*` repos are never eligible.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { computeTag, REGISTRY_PREFIX } from "./discovery-container-image.ts";

export const IMAGE_REPO = "releases-discovery-sandbox";
/** Repos this script may ever touch. Anything else (sunny-render*, …) is refused. */
export const PRUNABLE_REPOS = [IMAGE_REPO, "releases-discovery-staging-sandbox-staging"] as const;
const WRANGLER_CONFIG_REL = "workers/discovery/wrangler.jsonc";
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

/**
 * Extracts the pinned content-hash tag(s) for `repoPrefix` (e.g.
 * `registry.cloudflare.com/<acct>/releases-discovery-sandbox`) out of a
 * wrangler.jsonc file's text. Pure. Mirrors
 * discovery-container-image.ts's own image-field regex.
 */
export function extractPinnedTags(wranglerJsoncText: string, repoPrefix: string): Set<string> {
  const escaped = repoPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}:([a-f0-9]+)`, "g");
  const tags = new Set<string>();
  for (const m of wranglerJsoncText.matchAll(re)) tags.add(m[1]!);
  return tags;
}

/**
 * Content-hash keep tags pinned at each of the last `n` commits on
 * `origin/main` that touched `path` (Sunny's `resolveTagsFromGitHistory`,
 * buildinternet/sunny#1771). `gitLog`/`gitShowAt` are injected so this is
 * unit-testable without shelling out. Pure given those.
 */
export function resolveTagsFromGitHistory({
  n,
  repoPrefix,
  path,
  gitLog,
  gitShowAt,
}: {
  n: number;
  repoPrefix: string;
  path: string;
  gitLog: (n: number, path: string) => string[];
  gitShowAt: (sha: string, path: string) => string;
}): Set<string> {
  const shas = gitLog(n, path);
  const tags = new Set<string>();
  for (const sha of shas) {
    let content: string;
    try {
      content = gitShowAt(sha, path);
    } catch {
      continue;
    }
    for (const t of extractPinnedTags(content, repoPrefix)) tags.add(t);
  }
  return tags;
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

/** Tag out of a `…/<repo>:<tag>` image reference (null for `@sha256:` digest refs). */
export function tagFromImageRef(image: string | undefined): string | null {
  return /\/[^/@:]+:([A-Za-z0-9_.-]+)$/.exec(image ?? "")?.[1] ?? null;
}

/** Repo name (`releases-discovery-sandbox`) out of a container app's configured image. */
export function repoFromImageRef(image: string | undefined): string | null {
  return /\/([^/@:]+)[@:][^/]*$/.exec(image ?? "")?.[1] ?? null;
}

/** Names of container apps whose configured image lives in `repo`. Pure. */
export function appsReferencingRepo(
  apps: Array<{ name: string; image?: string }>,
  repo: string,
): string[] {
  return apps.filter((a) => repoFromImageRef(a.image) === repo).map((a) => a.name);
}

export function parseArgs(argv: string[]): { keep: number; yes: boolean; repo: string } {
  let keep = 5;
  let yes = false;
  let repo: string = IMAGE_REPO;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") {
      keep = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(keep) || keep < 0)
        throw new Error(`--keep must be a non-negative integer`);
    } else if (a === "--yes") yes = true;
    else if (a === "--repo") {
      repo = argv[++i] ?? "";
      if (!(PRUNABLE_REPOS as readonly string[]).includes(repo))
        throw new Error(`--repo must be one of ${PRUNABLE_REPOS.join(", ")}`);
    } else if (a === "--dry-run") {
      /* default */
    } else throw new Error(`Unknown flag: ${a}`);
  }
  return { keep, yes, repo };
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
  const { keep, yes, repo } = parseArgs(process.argv.slice(2));
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error(
      "prune-container-images: set CLOUDFLARE_ACCOUNT_ID (the account is shared; pin it explicitly).",
    );
    process.exit(2);
  }

  // 1a. Content-hash keep tags: the tag pinned in the current working tree
  //     plus the tags pinned at the last `keep` commits on origin/main that
  //     touched wrangler.jsonc (post-#2261 era; both envs share one repo/tag).
  const currentPinnedTag = computeTag();
  const gitHistoryTags = resolveTagsFromGitHistory({
    n: keep,
    repoPrefix: REGISTRY_PREFIX,
    path: WRANGLER_CONFIG_REL,
    gitLog: (n, path) =>
      execFileSync("git", ["log", "-n", String(n), "--format=%H", "origin/main", "--", path], {
        cwd: join(import.meta.dir, ".."),
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean),
    gitShowAt: (sha, path) =>
      execFileSync("git", ["show", `${sha}:${path}`], {
        cwd: join(import.meta.dir, ".."),
        encoding: "utf8",
      }),
  });
  const contentHashTags = new Set([currentPinnedTag, ...gitHistoryTags]);
  console.log(
    `content-hash keep tags (${contentHashTags.size}): ${[...contentHashTags].sort().join(", ")}`,
  );

  // 1b. Keep set from deployed Worker versions (the version-id era, still
  //     live for images pushed before #2261 redeploys land).
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
    // Union with the content-hash tags: the digest proof below accepts a
    // match against ANY tag in this per-env keep set, since the live app may
    // now be pinned to the content-hash tag instead of a version-id tag.
    const unioned = [...new Set([...tags, ...contentHashTags])];
    perEnv.push({ label: env.label, app: env.app, current, tags: unioned });
    console.log(`${env.label}: current ${current}, keeping ${unioned.join(", ")}`);
  }
  const keepSet = buildKeepSet([...perEnv.map((e) => e.tags), [...contentHashTags]]);

  // 2. Prove the keep-set → live-image mapping against each live app's
  //    digest: it must equal the registry digest of SOME tag in that env's
  //    keep set — the content-hash tag once redeployed post-#2261, or still
  //    the version-id tag until then. Only prod's app points at IMAGE_REPO;
  //    staging's app points at its own repo, so verify it there (same tag
  //    scheme) without ever pruning it.
  const apps = wranglerJson<Array<{ id: string; name: string }>>(["containers", "list"]);
  const creds = wranglerJson<{
    registry_host: string;
    account_id: string;
    username: string;
    password: string;
  }>(["containers", "registries", "credentials", "--pull"]);
  const appImages: Array<{ name: string; image?: string }> = [];
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
    appImages.push({ name: env.app, image: info.configuration?.image });
    const liveDigest = digestFromImageRef(info.configuration?.image);
    const liveTag = tagFromImageRef(info.configuration?.image);
    const repoOfApp = repoFromImageRef(info.configuration?.image) ?? "";
    let matchedTag: string | null = null;
    if (liveTag && env.tags.includes(liveTag)) {
      // Post-#2261 the app is configured by tag, so the proof is direct:
      // the tag it serves from must itself be in the keep set.
      matchedTag = liveTag;
    } else if (liveDigest) {
      for (const candidate of env.tags) {
        const tagDigest = await registryDigest(creds, repoOfApp, candidate);
        if (tagDigest && tagDigest === liveDigest) {
          matchedTag = candidate;
          break;
        }
      }
    }
    if (!matchedTag) {
      console.error(
        `prune-container-images: ${env.label} app image (${liveDigest ?? liveTag ?? "?"}) does not match the registry digest of any tag in its keep set (${env.tags.join(", ")}). The keep-tag → live-image assumption no longer holds; refusing to delete anything.`,
      );
      process.exit(1);
    }
    console.log(`${env.label}: live image digest matches ${repoOfApp}:${matchedTag} ✓`);
  }

  // 2b. A non-default repo may only be pruned when nothing serves from it.
  if (repo !== IMAGE_REPO) {
    const users = appsReferencingRepo(appImages, repo);
    if (users.length > 0) {
      console.error(
        `prune-container-images: ${repo} is still referenced by live app(s) ${users.join(", ")} — refusing to prune it.`,
      );
      process.exit(1);
    }
    console.log(
      `${repo}: no live container app references it ✓ (keeping recent version-id tags for rollback)`,
    );
  }

  // 3. Candidates from the only trustworthy listing.
  const listing = wranglerJson(["containers", "images", "list"]);
  const entry = findRepoEntry(listing, repo);
  if (!entry) {
    console.error(
      `prune-container-images: \`wrangler containers images list\` has no entry for ${repo}; refusing to delete anything.`,
    );
    process.exit(1);
  }
  const plan = planPrune(entry.tags, keepSet);
  const deletes = plan.filter((p) => p.action === "delete");
  const missingKeep = [...keepSet].filter((t) => !entry.tags.includes(t));

  console.log(`\nkeep set (${keepSet.size}): ${[...keepSet].sort().join(", ")}`);
  if (missingKeep.length)
    console.log(
      `(keep-set tags not present in ${repo}, e.g. the other env's version-id tags): ${missingKeep.join(", ")}`,
    );
  console.log(
    `\n${repo}: ${plan.length} tags, ${plan.length - deletes.length} keep / ${deletes.length} delete`,
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
    const ref = `${repo}:${row.tag}`;
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
