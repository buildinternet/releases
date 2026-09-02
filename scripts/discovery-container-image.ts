/**
 * Content-hash tag management for the discovery worker's `Sandbox` container
 * image (#2261). Ports Sunny's `scripts/render-container-image.mjs`
 * (buildinternet/sunny#1657, #1773, #1742) to this repo's TS/Bun style.
 *
 * Problem: `workers/discovery/wrangler.jsonc` used to build the image from
 * `./Dockerfile` on every `wrangler deploy`, so every prod/staging deploy
 * pushed a fresh, unpruned tag to the managed registry — how
 * `releases-discovery-sandbox` reached 712 tags (see
 * scripts/prune-container-images.ts, #2260).
 *
 * Fix: pin `containers[].image` (root + `env.staging`) to a literal
 * `registry.cloudflare.com/<account>/releases-discovery-sandbox:<tag>`, where
 * `<tag>` is a content hash of the image's real inputs. Deploys call `ensure`
 * instead of unconditionally building: it's a no-op once the tag is pushed.
 *
 * Hashing: the Dockerfile only COPYs `.claude/skills/` (build context is the
 * repo root, per `image_build_context: "../../"`), so the inputs are the
 * Dockerfile itself plus that directory tree. `git ls-files -s -- <paths>`
 * gives a deterministic (mtime-independent) manifest of committed blobs; a
 * path with uncommitted changes (`git status --porcelain`) is instead hashed
 * via `git hash-object` on its current working-tree bytes, so local edits
 * move the tag before a commit exists. The final tag is
 * `sha256(manifest).slice(0, 12)`.
 *
 * Subcommands:
 *   tag     Print the current `<tag>` (default).
 *   check   Verify wrangler.jsonc's `containers[].image` fields (root + env
 *           .staging) pin the current tag. Exit 1 otherwise — used in CI lint.
 *   write   Rewrite those image fields to the current tag.
 *   ensure  Compute the tag, hard-fail if wrangler.jsonc doesn't pin it, then
 *           check `wrangler containers images list --json` (the only
 *           trusted exists oracle, see prune-container-images.ts) — build +
 *           push only if the tag is missing. Idempotent. Used by CI deploy.
 *
 * `wrangler containers build <PATH>` builds a Dockerfile literally at
 * `<PATH>/Dockerfile` using `<PATH>` as the build context — it has no
 * separate context flag, so it cannot express this repo's split (Dockerfile
 * at workers/discovery/Dockerfile, context the repo root). `ensure` instead
 * shells out to `docker build -f workers/discovery/Dockerfile` with the repo
 * root as context (matching `image_build_context: "../../"`), then
 * `wrangler containers push` the tagged local image — the same two
 * primitives `containers build -p` composes internally, just split so the
 * Dockerfile-outside-context layout works. See docs/architecture/
 * deploy-coupling.md → "Container image retention".
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..");
const WRANGLER_JSONC_REL = "workers/discovery/wrangler.jsonc";
const WRANGLER_JSONC = join(REPO_ROOT, WRANGLER_JSONC_REL);
const DOCKERFILE_REL = "workers/discovery/Dockerfile";
const SKILLS_DIR_REL = ".claude/skills";

export const CF_ACCOUNT_ID = "b082600d280d44fd5da3501bc1bffe2f";
export const IMAGE_REPO = "releases-discovery-sandbox";
export const REGISTRY_PREFIX = `registry.cloudflare.com/${CF_ACCOUNT_ID}/${IMAGE_REPO}`;

/** Image inputs, relative to REPO_ROOT (the Dockerfile's build context). */
export const INPUT_PATHS = [DOCKERFILE_REL, SKILLS_DIR_REL];

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/**
 * sha256(manifest of image inputs), truncated to 12 hex chars. Pure aside
 * from the `git` shell-outs; the manifest-building logic itself is exercised
 * indirectly via computeTag in tests against a scratch git repo.
 */
export function computeTag(): string {
  const paths = INPUT_PATHS;
  const lsFiles = git(["ls-files", "-s", "--", ...paths]).trim();
  const lines = lsFiles.length > 0 ? lsFiles.split("\n") : [];

  // trimEnd, not trim: porcelain lines start with a two-char XY status whose
  // first char can be a space (" M path") — a full trim on the first line
  // would eat that leading space and mangle the path via .slice(3).
  const dirtyPorcelain = git(["status", "--porcelain", "--", ...paths]).trimEnd();
  const dirtyPaths = new Set(
    dirtyPorcelain.length > 0
      ? dirtyPorcelain
          .split("\n")
          .map((line) => line.slice(3).trim())
          .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1]! : p))
      : [],
  );

  const entries: string[] = [];
  for (const line of lines) {
    const tabIdx = line.indexOf("\t");
    const meta = line.slice(0, tabIdx);
    const path = line.slice(tabIdx + 1);
    const [mode] = meta.split(" ");
    let sha = meta.split(" ")[1];
    if (dirtyPaths.has(path)) {
      try {
        sha = git(["hash-object", join(REPO_ROOT, path)]).trim();
      } catch {
        // Deleted in the working tree: omit it — an unstaged deletion moves
        // the tag rather than reusing the stale blob.
        continue;
      }
    }
    entries.push(`${mode} ${sha} ${path}`);
  }

  // Untracked (never-committed) inputs don't appear in `git ls-files` — hash
  // them from working-tree bytes so a brand-new file moves the tag before
  // its first commit.
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...paths]).trim();
  for (const path of untracked.length > 0 ? untracked.split("\n") : []) {
    try {
      const sha = git(["hash-object", join(REPO_ROOT, path)]).trim();
      entries.push(`100644 ${sha} ${path}`);
    } catch {
      // Raced deletion; ignore.
    }
  }

  entries.sort();
  const manifest = entries.join("\n");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(manifest);
  return hasher.digest("hex").slice(0, 12);
}

function currentWranglerImages(): { raw: string; matches: string[] } {
  const raw = readFileSync(WRANGLER_JSONC, "utf8");
  const escaped = REGISTRY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`"image":\\s*"(${escaped}:[a-f0-9]+)"`, "g");
  const matches = [...raw.matchAll(re)].map((m) => m[1]!);
  return { raw, matches };
}

/** Verify wrangler.jsonc pins the current tag in both `image` fields. Pure over `raw`. */
export function checkAgainstRaw(
  raw: string,
  expectedTag: string,
): { ok: boolean; reason?: string } {
  const escaped = REGISTRY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`"image":\\s*"(${escaped}:[a-f0-9]+)"`, "g");
  const matches = [...raw.matchAll(re)].map((m) => m[1]!);
  if (matches.length !== 2) {
    return {
      ok: false,
      reason: `expected 2 pinned registry image references in ${WRANGLER_JSONC_REL} (root + env.staging), found ${matches.length}.`,
    };
  }
  const expected = `${REGISTRY_PREFIX}:${expectedTag}`;
  const stale = matches.filter((m) => m !== expected);
  if (stale.length > 0) {
    return {
      ok: false,
      reason: `stale pinned image tag(s): expected ${expected}, found ${[...new Set(stale)].join(", ")}.`,
    };
  }
  return { ok: true };
}

function checkCommand({ silent = false } = {}): boolean {
  const hash = computeTag();
  const { raw } = currentWranglerImages();
  const result = checkAgainstRaw(raw, hash);
  if (!result.ok) {
    if (!silent) {
      console.error(`discovery-container-image check: ${result.reason}`);
      console.error(`Fix by running: bun scripts/discovery-container-image.ts write`);
    }
    return false;
  }
  if (!silent) console.log(`discovery-container-image check: OK (${REGISTRY_PREFIX}:${hash})`);
  return true;
}

function writeCommand(): void {
  const hash = computeTag();
  const target = `${REGISTRY_PREFIX}:${hash}`;
  const { raw } = currentWranglerImages();
  const escapedPrefix = REGISTRY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`"image":\\s*"(?:\\./Dockerfile|${escapedPrefix}:[a-f0-9]+)"`, "g");
  const rewritten = raw.replace(re, `"image": "${target}"`);
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const count = (rewritten.match(new RegExp(escapedTarget, "g")) ?? []).length;

  if (count !== 2) {
    console.error(
      `discovery-container-image write: expected to rewrite 2 image fields, rewrote ${count}. Check ${WRANGLER_JSONC_REL}'s containers[] entries by hand.`,
    );
    process.exit(1);
  }

  writeFileSync(WRANGLER_JSONC, rewritten);
  console.log(`discovery-container-image write: ${WRANGLER_JSONC_REL} now pins ${target}`);
}

/**
 * `wrangler containers images list --json` — the only trusted exists oracle
 * (see scripts/prune-container-images.ts for the same trust boundary).
 * Never throws; a failure to reach a clean parse is reported as "unknown",
 * not "missing" — never skip a needed push on an ambiguous signal.
 */
function queryImagesList(tag: string): {
  status: "exists" | "missing" | "unknown";
  reason?: string;
} {
  let out: string;
  try {
    out = execFileSync("npx", ["wrangler", "containers", "images", "list", "--json"], {
      cwd: join(REPO_ROOT, "workers/discovery"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (err) {
    const e = err as { killed?: boolean; stderr?: string; stdout?: string; message?: string };
    const reason = e.killed
      ? "timed out"
      : String(e.stderr ?? e.stdout ?? e.message ?? "").trim() ||
        "`wrangler containers images list --json` failed";
    return { status: "unknown", reason };
  }

  let images: unknown;
  try {
    images = JSON.parse(out);
  } catch {
    return { status: "unknown", reason: "could not parse images list JSON output" };
  }

  const list = Array.isArray(images)
    ? images
    : ((images as { images?: unknown[]; result?: unknown[] })?.images ?? []);
  const found = (list as Array<Record<string, unknown>>).some((img) => {
    if (img.name !== IMAGE_REPO) return false;
    const tags = (img.tags as string[] | undefined) ?? [];
    return tags.includes(tag);
  });
  return { status: found ? "exists" : "missing" };
}

function ensureCommand(): void {
  const hash = computeTag();
  const target = `${REGISTRY_PREFIX}:${hash}`;

  const { raw } = currentWranglerImages();
  const result = checkAgainstRaw(raw, hash);
  if (!result.ok) {
    console.error(`discovery-container-image ensure: ${result.reason}`);
    console.error(`Run: bun scripts/discovery-container-image.ts write   (and commit the result)`);
    process.exit(1);
  }

  const listResult = queryImagesList(hash);
  if (listResult.status === "unknown") {
    console.error(`discovery-container-image ensure: ${listResult.reason}`);
    process.exit(1);
  }
  if (listResult.status === "exists") {
    console.log(`discovery-container-image ensure: ${target} already in the registry — no-op.`);
    return;
  }

  console.log(
    `discovery-container-image ensure: ${target} not found in the registry — building and pushing.`,
  );
  const localTag = `${IMAGE_REPO}:${hash}`;
  execFileSync(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "-f",
      join(REPO_ROOT, DOCKERFILE_REL),
      "-t",
      localTag,
      REPO_ROOT,
    ],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  execFileSync("npx", ["wrangler", "containers", "push", localTag], {
    cwd: join(REPO_ROOT, "workers/discovery"),
    stdio: "inherit",
  });
  console.log(`discovery-container-image ensure: pushed ${target}.`);
}

function tagCommand(): void {
  console.log(computeTag());
}

const isMain = import.meta.main;

if (isMain) {
  const cmd = process.argv[2] ?? "tag";
  switch (cmd) {
    case "tag":
      tagCommand();
      break;
    case "check":
      process.exit(checkCommand() ? 0 : 1);
      break;
    case "write":
      writeCommand();
      break;
    case "ensure":
      ensureCommand();
      break;
    default:
      console.error(`Unknown subcommand: ${cmd}`);
      console.error(`Usage: bun scripts/discovery-container-image.ts [tag|check|write|ensure]`);
      process.exit(1);
  }
}
