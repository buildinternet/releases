#!/usr/bin/env node
// Validate a releases.json v2 manifest against the releases.sh rules.
//
// Zero dependencies — runs under Node 18+ or Bun with no install step, so it
// works inside any vendor repo. It encodes the full contract, including the
// three rules the published JSON Schema can't express on its own:
//   1. every releases[] entry needs at least one locator (url/feed/github/appstore/file)
//   2. at most one entry per array may be "canonical": true
//   3. a file may declare at most 32 release locations in total (top-level + all products)
//
// Usage:
//   node validate.mjs <path-to-releases.json> [--scope domain|repo]
//
// Scope is auto-detected when omitted: a `product` key or `github: "self"`
// means repository scope; otherwise domain (well-known) scope. Exit code is 0
// when valid, 1 when not (or on a usage/parse error).

import { readFileSync } from "node:fs";

const MAX_PRODUCTS = 24;
const MAX_PRODUCT_RELEASES = 8;
const MAX_FILE_RELEASES = 32;

const GITHUB_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ORG_ID = /^org_[A-Za-z0-9]+$/;
const PRD_ID = /^prd_[A-Za-z0-9]+$/;

const errors = [];
const err = (path, msg) => errors.push(`${path}: ${msg}`);

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function isUrl(v) {
  if (typeof v !== "string") return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}
const isHttpsUrl = (v) => isUrl(v) && v.startsWith("https://");

function checkStr(path, v, { min = 0, max = Infinity } = {}) {
  if (typeof v !== "string") return err(path, "must be a string");
  if (v.length < min) err(path, `must be at least ${min} character(s)`);
  if (v.length > max) err(path, `must be at most ${max} characters`);
}

function checkKnownKeys(path, obj, allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) err(path, `unknown key "${key}" (not allowed here)`);
  }
}

function checkSocial(path, social) {
  if (!isObject(social)) return err(path, "must be an object of handle => value");
  for (const [k, v] of Object.entries(social)) {
    checkStr(`${path}.${k} (key)`, k, { min: 1, max: 40 });
    checkStr(`${path}.${k}`, v, { min: 1, max: 200 });
  }
}

function checkTags(path, tags) {
  if (!Array.isArray(tags)) return err(path, "must be an array");
  if (tags.length > 50) err(path, "may hold at most 50 tags");
  tags.forEach((t, i) => checkStr(`${path}[${i}]`, t, { min: 1, max: 60 }));
}

function checkRegistries(path, reg) {
  if (!isObject(reg)) return err(path, "must be an object");
  const rsh = reg["releases.sh"];
  if (rsh === undefined) return; // other registries are allowed and ignored
  if (!isObject(rsh)) return err(`${path}["releases.sh"]`, "must be an object");
  if (rsh.org !== undefined && !ORG_ID.test(rsh.org))
    err(`${path}["releases.sh"].org`, 'must match "org_…"');
  if (rsh.product !== undefined && !PRD_ID.test(rsh.product))
    err(`${path}["releases.sh"].product`, 'must match "prd_…"');
  if (rsh.verification !== undefined)
    checkStr(`${path}["releases.sh"].verification`, rsh.verification, { min: 1, max: 500 });
}

// One release-location entry. `allowSelf` toggles github: "self" (repo scope only).
function checkRelease(path, entry, allowSelf) {
  if (!isObject(entry)) return err(path, "must be an object");
  checkKnownKeys(path, entry, ["url", "feed", "appstore", "file", "title", "canonical", "github"]);

  for (const key of ["url", "feed", "appstore", "file"]) {
    if (entry[key] !== undefined && !isHttpsUrl(entry[key]))
      err(`${path}.${key}`, "must be an https:// URL");
  }
  if (entry.title !== undefined) checkStr(`${path}.title`, entry.title, { min: 1, max: 200 });
  if (entry.canonical !== undefined && typeof entry.canonical !== "boolean")
    err(`${path}.canonical`, "must be true or false");
  if (entry.github !== undefined) {
    const ok = GITHUB_REPO.test(entry.github) || (allowSelf && entry.github === "self");
    if (!ok)
      err(`${path}.github`, allowSelf ? 'must be "owner/repo" or "self"' : 'must be "owner/repo"');
  }

  const hasLocator = entry.url || entry.feed || entry.github || entry.appstore || entry.file;
  if (!hasLocator) err(path, "needs at least one locator: url, feed, github, appstore, or file");
}

function checkReleasesArray(path, arr, { max, allowSelf }) {
  if (!Array.isArray(arr)) return err(path, "must be an array");
  if (arr.length > max) err(path, `may hold at most ${max} entries`);
  arr.forEach((entry, i) => checkRelease(`${path}[${i}]`, entry, allowSelf));
  const canonical = arr.filter((e) => isObject(e) && e.canonical === true).length;
  if (canonical > 1) err(path, 'at most one entry may be marked "canonical": true');
}

function checkProduct(path, p) {
  if (!isObject(p)) return err(path, "must be an object");
  checkKnownKeys(path, p, [
    "name",
    "slug",
    "kind",
    "category",
    "description",
    "website",
    "docs",
    "support",
    "social",
    "tags",
    "archived",
    "releases",
  ]);
  if (p.name === undefined) err(path, 'is missing required "name"');
  else checkStr(`${path}.name`, p.name, { min: 1, max: 120 });
  for (const key of ["slug", "kind", "category"])
    if (p[key] !== undefined) checkStr(`${path}.${key}`, p[key], { min: 1, max: 120 });
  if (p.description !== undefined) checkStr(`${path}.description`, p.description, { max: 2000 });
  for (const key of ["website", "docs", "support"])
    if (p[key] !== undefined && !isUrl(p[key])) err(`${path}.${key}`, "must be a URL");
  if (p.social !== undefined) checkSocial(`${path}.social`, p.social);
  if (p.tags !== undefined) checkTags(`${path}.tags`, p.tags);
  if (p.archived !== undefined && typeof p.archived !== "boolean")
    err(`${path}.archived`, "must be true or false");
  if (p.releases !== undefined)
    checkReleasesArray(`${path}.releases`, p.releases, {
      max: MAX_PRODUCT_RELEASES,
      allowSelf: false,
    });
}

function validateDomain(m) {
  checkKnownKeys("(root)", m, [
    "$schema",
    "version",
    "registries",
    "releases",
    "name",
    "description",
    "category",
    "avatar",
    "tags",
    "social",
    "products",
  ]);
  if (m.name !== undefined) checkStr("name", m.name, { min: 1, max: 120 });
  if (m.description !== undefined) checkStr("description", m.description, { max: 2000 });
  if (m.category !== undefined) checkStr("category", m.category, { min: 1, max: 120 });
  if (m.avatar !== undefined && !isHttpsUrl(m.avatar)) err("avatar", "must be an https:// URL");
  if (m.tags !== undefined) checkTags("tags", m.tags);
  if (m.social !== undefined) checkSocial("social", m.social);

  let totalReleases = 0;
  if (m.releases !== undefined) {
    checkReleasesArray("releases", m.releases, { max: MAX_FILE_RELEASES, allowSelf: false });
    if (Array.isArray(m.releases)) totalReleases += m.releases.length;
  }
  if (m.products !== undefined) {
    if (!Array.isArray(m.products)) err("products", "must be an array");
    else {
      if (m.products.length > MAX_PRODUCTS)
        err("products", `may hold at most ${MAX_PRODUCTS} products`);
      m.products.forEach((p, i) => {
        checkProduct(`products[${i}]`, p);
        if (isObject(p) && Array.isArray(p.releases)) totalReleases += p.releases.length;
      });
    }
  }
  if (totalReleases > MAX_FILE_RELEASES)
    err(
      "(root)",
      `at most ${MAX_FILE_RELEASES} release locations total (top-level + every product combined); found ${totalReleases}`,
    );
}

function validateRepo(m) {
  checkKnownKeys("(root)", m, ["$schema", "version", "registries", "product", "releases"]);
  if (m.product !== undefined) {
    if (!isObject(m.product)) err("product", "must be an object");
    else {
      checkKnownKeys("product", m.product, ["name", "slug"]);
      if (m.product.name === undefined) err("product", 'is missing required "name"');
      else checkStr("product.name", m.product.name, { min: 1, max: 120 });
      if (m.product.slug !== undefined)
        checkStr("product.slug", m.product.slug, { min: 1, max: 120 });
    }
  }
  if (m.releases !== undefined)
    checkReleasesArray("releases", m.releases, { max: MAX_FILE_RELEASES, allowSelf: true });
}

function detectScope(m) {
  if (m.product !== undefined) return "repo";
  if (Array.isArray(m.releases) && m.releases.some((e) => isObject(e) && e.github === "self"))
    return "repo";
  if (
    m.products !== undefined ||
    m.name !== undefined ||
    m.avatar !== undefined ||
    m.tags !== undefined
  )
    return "domain";
  return "domain"; // a bare { version, releases } file is a valid domain manifest
}

// ---- entry point ----
const args = process.argv.slice(2);
const scopeFlagIdx = args.indexOf("--scope");
let scopeFlag = null;
if (scopeFlagIdx !== -1) {
  scopeFlag = args[scopeFlagIdx + 1];
  args.splice(scopeFlagIdx, 2);
}
const filePath = args[0];

if (!filePath) {
  console.error("usage: node validate.mjs <path-to-releases.json> [--scope domain|repo]");
  process.exit(1);
}
if (scopeFlag && scopeFlag !== "domain" && scopeFlag !== "repo") {
  console.error(`invalid --scope "${scopeFlag}" (expected "domain" or "repo")`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(filePath, "utf8");
} catch (e) {
  console.error(`cannot read ${filePath}: ${e.message}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(raw);
} catch (e) {
  console.error(`✗ ${filePath} is not valid JSON: ${e.message}`);
  process.exit(1);
}

if (!isObject(manifest)) {
  console.error("✗ top level must be a JSON object");
  process.exit(1);
}

// version + $schema/registries are common to both scopes.
if (manifest.version !== 2)
  err("version", "is required and must be the number 2 (v1 files are no longer read)");
if (manifest.$schema !== undefined && !isUrl(manifest.$schema)) err("$schema", "must be a URL");
if (manifest.registries !== undefined) checkRegistries("registries", manifest.registries);

const scope = scopeFlag || detectScope(manifest);
if (scope === "repo") validateRepo(manifest);
else validateDomain(manifest);

if (errors.length === 0) {
  console.log(`✓ ${filePath} is a valid releases.json v2 manifest (${scope} scope).`);
  process.exit(0);
}
console.error(`✗ ${filePath} is not valid (${scope} scope). ${errors.length} problem(s):\n`);
for (const e of errors) console.error(`  • ${e}`);
console.error(
  scopeFlag
    ? ""
    : `\n(Scope auto-detected as "${scope}". If that's wrong, re-run with --scope domain|repo.)`,
);
process.exit(1);
