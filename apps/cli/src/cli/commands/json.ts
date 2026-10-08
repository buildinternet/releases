import { Command } from "commander";
import chalk from "chalk";
import { existsSync, writeFileSync } from "node:fs";
import {
  ReleasesJsonConfigSchema,
  ReleasesJsonDomainSchema,
  ReleasesJsonRepoSchema,
} from "@buildinternet/releases-api-types";
import type { ListingValidationResult } from "@buildinternet/releases-api-types";
import { logger } from "@buildinternet/releases-lib/logger";
import { readContentArg } from "../../lib/input.js";
import { writeJson } from "../../lib/output.js";
import { getApiUrl } from "../../lib/mode.js";
import { apiFetch } from "../../api/core.js";
import { ApiError } from "../../lib/errors.js";

// The owner-declared manifest documented at https://releases.sh/docs/listing.
// Two hosting scopes share one public union schema (ReleasesJsonConfigSchema):
//   - domain: /.well-known/releases.json — flat org identity + products[]
//   - repo:   repo-root releases.json    — product binding + repo releases[]
// See buildinternet/releases#1908 (v2 manifest) / releases-cli#351.

type Scope = "domain" | "repo";

interface Issue {
  path: string;
  message: string;
  code: string;
}

interface ValidateResult {
  target: string;
  valid: boolean;
  scope: Scope | null;
  issues: Issue[];
  summary?: DomainSummary | RepoSummary;
}

interface DomainSummary {
  scope: "domain";
  name: string | null;
  category: string | null;
  products: number;
  releaseLocations: number;
  registryBinding: RegistryBinding | null;
}

interface RepoSummary {
  scope: "repo";
  product: string | null;
  releaseLocations: number;
  registryBinding: RegistryBinding | null;
}

interface RegistryBinding {
  org: string | null;
  product: string | null;
  verification: boolean;
}

// A bare hostname (no scheme, path, port, or query) — the future `domain` form.
// A local file argument almost always carries a `.`-json suffix, a path
// separator, or is `-`, so this only misfires on a dotted, slash-free,
// non-existent argument, which is exactly the domain intent.
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

function looksLikeDomain(target: string): boolean {
  if (target === "-") return false;
  if (target.includes("/") || target.includes("\\")) return false;
  // A `.json` argument is always a file — even a missing one — so a typo'd path
  // surfaces a clean "cannot read file" instead of the domain-deferred notice.
  if (target.toLowerCase().endsWith(".json")) return false;
  if (existsSync(target)) return false;
  return HOSTNAME_RE.test(target);
}

// The single top-level discriminator between the two hosting scopes: only the
// repo-root manifest declares `product` (singular). Everything else — including
// a minimal `{version, releases}` file — is treated as domain scope, which
// picks the right scoped schema for readable error messages.
function detectScope(data: unknown): Scope {
  if (typeof data === "object" && data !== null && "product" in data) return "repo";
  return "domain";
}

function scopeSchema(
  scope: Scope,
): typeof ReleasesJsonDomainSchema | typeof ReleasesJsonRepoSchema {
  return scope === "repo" ? ReleasesJsonRepoSchema : ReleasesJsonDomainSchema;
}

// Structurally typed to sidestep the dual-zod version skew between this repo's
// pinned zod and the copy api-types resolves — we only read `path`/`message`/
// `code` off each issue.
interface ZodIssueLike {
  path: PropertyKey[];
  message: string;
  code: string;
}

function collectIssues(error: { issues: ZodIssueLike[] }): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length ? issue.path.map(String).join(".") : "(root)",
    message: issue.message,
    code: issue.code,
  }));
}

function countReleaseLocations(parsed: Record<string, unknown>): number {
  const top = Array.isArray(parsed.releases) ? parsed.releases.length : 0;
  const products = Array.isArray(parsed.products) ? parsed.products : [];
  const nested = products.reduce<number>((sum, product) => {
    const rel = (product as { releases?: unknown }).releases;
    return sum + (Array.isArray(rel) ? rel.length : 0);
  }, 0);
  return top + nested;
}

function registryBinding(parsed: Record<string, unknown>): RegistryBinding | null {
  const registries = parsed.registries as Record<string, unknown> | undefined;
  const entry = registries?.["releases.sh"] as Record<string, unknown> | undefined;
  if (!entry) return null;
  return {
    org: typeof entry.org === "string" ? entry.org : null,
    product: typeof entry.product === "string" ? entry.product : null,
    verification: typeof entry.verification === "string" && entry.verification.length > 0,
  };
}

function buildSummary(parsed: Record<string, unknown>, scope: Scope): DomainSummary | RepoSummary {
  const binding = registryBinding(parsed);
  if (scope === "repo") {
    const product = parsed.product as { name?: string; slug?: string } | undefined;
    return {
      scope: "repo",
      product: product?.slug ?? product?.name ?? null,
      releaseLocations: Array.isArray(parsed.releases) ? parsed.releases.length : 0,
      registryBinding: binding,
    };
  }
  return {
    scope: "domain",
    name: typeof parsed.name === "string" ? parsed.name : null,
    category: typeof parsed.category === "string" ? parsed.category : null,
    products: Array.isArray(parsed.products) ? parsed.products.length : 0,
    releaseLocations: countReleaseLocations(parsed),
    registryBinding: binding,
  };
}

function line(label: string, value: string): void {
  console.log(`  ${chalk.dim(label.padEnd(16))}${value}`);
}

function printSummary(summary: DomainSummary | RepoSummary): void {
  console.log(chalk.green("✓ valid releases.json") + chalk.dim(` (${summary.scope} scope)`));
  if (summary.scope === "domain") {
    if (summary.name) line("org", summary.name);
    if (summary.category) line("category", summary.category);
    line("products", String(summary.products));
  } else {
    line("product", summary.product ?? chalk.dim("(unbound)"));
  }
  line("release locators", String(summary.releaseLocations));
  const binding = summary.registryBinding;
  if (binding) {
    const parts: string[] = [];
    if (binding.org) parts.push(`org ${binding.org}`);
    if (binding.product) parts.push(`product ${binding.product}`);
    if (binding.verification) parts.push("verification set");
    line("releases.sh", parts.length ? parts.join(", ") : chalk.dim("(present, empty)"));
  }
}

function printIssues(target: string, scope: Scope, issues: Issue[]): void {
  console.log(chalk.red(`✗ invalid releases.json`) + chalk.dim(` (${scope} scope) — ${target}`));
  console.log("");
  for (const issue of issues) {
    console.log(`  ${chalk.yellow(issue.path)}  ${issue.message}`);
  }
  console.log("");
  console.log(
    chalk.dim(
      `${issues.length} issue${issues.length === 1 ? "" : "s"}. Schema: https://releases.sh/docs/listing`,
    ),
  );
}

// The domain form. The verdict comes from the shared web fast-lane backend
// (POST /v1/listing/validate — buildinternet/releases#1910/#1947 phase 2) so
// web and CLI never disagree: the API fetches https://<domain>/.well-known/
// releases.json live and returns the validation verdict plus the
// materialization plan. Anonymous, per-IP rate-limited; no auth header.
async function runDomainValidate(target: string, opts: { json?: boolean }): Promise<never> {
  let res: Response;
  try {
    res = await fetch(`${getApiUrl()}/v1/listing/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: target }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `Could not reach the listing endpoint: ${detail}`;
    if (opts.json) {
      await writeJson({ target, valid: false, scope: null, issues: [], message });
    } else {
      logger.error(message);
    }
    process.exit(1);
  }

  if (!res.ok) {
    let message = "Validation request failed. Please try again.";
    if (res.status === 429) {
      message = "Too many checks — please try again in a minute.";
    } else {
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (typeof body?.error?.message === "string") message = body.error.message;
      } catch {
        // keep the generic fallback
      }
    }
    if (opts.json) {
      await writeJson({ target, valid: false, scope: null, issues: [], message });
    } else {
      console.log(chalk.red(message));
    }
    process.exit(1);
  }

  let result: ListingValidationResult;
  try {
    result = (await res.json()) as ListingValidationResult;
  } catch {
    const message = "The listing endpoint returned an unreadable response. Please try again.";
    if (opts.json) {
      await writeJson({ target, valid: false, scope: null, issues: [], message });
    } else {
      console.log(chalk.red(message));
    }
    process.exit(1);
  }

  if (opts.json) {
    // Raw wire shape merged with the target — deliberately NOT the local-file
    // ValidateResult: the domain form's verdict carries the materialization
    // plan (domainStatus/identity/products/locations), not zod issues.
    await writeJson({ target, ...result });
    process.exit(result.valid ? 0 : 1);
  }

  if (!result.valid) {
    printIssues(
      target,
      "domain",
      result.errors.map((e) => ({ path: e.path, message: e.message, code: "invalid" })),
    );
    process.exit(1);
  }

  console.log(chalk.green("✓ valid releases.json") + chalk.dim(` (domain — ${target})`));
  if (result.identity) {
    line("org", result.identity.name);
    line("slug", result.identity.slug);
    line("domain", result.identity.domain);
  }
  if (result.products?.length) {
    line(
      "products",
      result.products
        .map((p) => `${p.name} (${p.locationCount} locator${p.locationCount === 1 ? "" : "s"})`)
        .join(", "),
    );
  }
  line("status", result.domainStatus);
  if (result.locations.length) {
    console.log("");
    console.log(chalk.dim("  release locators"));
    for (const loc of result.locations) {
      const classification =
        loc.classification === "tier1-live"
          ? chalk.green("goes live")
          : chalk.yellow("reviewed first");
      console.log(`    ${chalk.cyan(loc.kind.padEnd(9))}${loc.locator}`);
      console.log(`    ${" ".repeat(9)}${classification}${chalk.dim(` — ${loc.becomes}`)}`);
    }
  }
  console.log("");
  if (result.domainStatus === "unlisted") {
    console.log(`Activate at https://releases.sh/submit`);
  } else {
    console.log(
      `This domain is already listed.${result.org ? ` ${chalk.dim(result.org.webUrl)}` : ""}`,
    );
  }
  process.exit(0);
}

export async function runValidate(target: string, opts: { json?: boolean }): Promise<void> {
  if (looksLikeDomain(target)) {
    await runDomainValidate(target, opts);
  }

  const raw = await readContentArg(target);

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      const result: ValidateResult = {
        target,
        valid: false,
        scope: null,
        issues: [{ path: "(root)", message: `not valid JSON: ${detail}`, code: "invalid_json" }],
      };
      await writeJson(result);
    } else {
      logger.error(`Not valid JSON: ${detail}`);
    }
    process.exit(1);
  }

  const verdict = ReleasesJsonConfigSchema.safeParse(data);
  const scope = detectScope(data);

  if (verdict.success) {
    const summary = buildSummary(data as Record<string, unknown>, scope);
    const result: ValidateResult = {
      target,
      valid: true,
      scope,
      issues: [],
      summary,
    };
    if (opts.json) {
      await writeJson(result);
    } else {
      printSummary(summary);
    }
    return;
  }

  // The union's own error nests both branches' failures, which is noise. Re-run
  // against the scope the file clearly intended for readable, path-anchored
  // messages.
  const scoped = scopeSchema(scope).safeParse(data);
  const issues = scoped.success ? collectIssues(verdict.error) : collectIssues(scoped.error);

  const result: ValidateResult = { target, valid: false, scope, issues };
  if (opts.json) {
    await writeJson(result);
  } else {
    printIssues(target, scope, issues);
  }
  process.exit(1);
}

// Export the reverse direction: reconstruct a releases.json domain manifest
// from an org already tracked in the registry, so an owner can host it at
// /.well-known/releases.json and take ownership of their listing. The backend
// endpoint (GET /v1/orgs/:slug/manifest) is the single source of truth for the
// source→locator mapping; the CLI is a thin client that fetches and validates.
export async function runExport(org: string, opts: { output?: string }): Promise<void> {
  // Route through the shared apiFetch so this command inherits the common
  // transport-error handling, error-envelope parsing, and JSON decoding used by
  // every other reader command. A GET 404 resolves to `null` (org not tracked);
  // any other non-2xx or a malformed body throws (ApiError / parse error).
  let manifest: unknown;
  try {
    manifest = await apiFetch(`/v1/orgs/${encodeURIComponent(org)}/manifest`);
  } catch (err) {
    const detail =
      err instanceof ApiError
        ? err.serverMessage
        : err instanceof Error
          ? err.message
          : String(err);
    logger.error(`Export failed: ${detail}`);
    process.exit(1);
  }

  if (manifest === null) {
    logger.error(
      `No tracked org found for "${org}". Pass the org slug (e.g. \`releases json export vercel\`).`,
    );
    process.exit(1);
  }

  // The manifest comes from our own backend, which builds and validates it
  // before returning. We deliberately do NOT re-validate against this CLI's
  // pinned api-types schema: the deployed API tracks monorepo HEAD and can
  // legitimately emit fields newer than the last published schema (e.g.
  // product-level tags) — re-checking would false-alarm on a valid manifest.
  // A minimal shape guard still catches a genuinely broken response (an error
  // envelope, an empty body) without rejecting forward-compatible fields.
  if (
    !manifest ||
    typeof manifest !== "object" ||
    (manifest as { version?: unknown }).version !== 2
  ) {
    logger.error("Unexpected response from the API (not a releases.json v2 manifest).");
    process.exit(1);
  }

  const json = JSON.stringify(manifest, null, 2) + "\n";
  if (opts.output) {
    try {
      writeFileSync(opts.output, json);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(`Could not write ${opts.output}: ${detail}`);
      process.exit(1);
    }
    // Confirmation to stderr so stdout stays clean when the manifest is piped.
    logger.info(`Wrote ${opts.output}`);
  } else {
    // The manifest itself is the machine output — write it directly to stdout.
    if (!process.stdout.write(json)) {
      await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
    }
  }
}

export function registerJsonCommand(program: Command): void {
  const json = program
    .command("json")
    .description("Work with releases.json owner manifests")
    .showSuggestionAfterError(true)
    .action(() => {
      console.log(chalk.dim('Run "releases json --help" to see manifest commands.'));
    });

  json
    .command("validate")
    .description("Validate a releases.json manifest against the v2 schema")
    .argument("<target>", 'Path to a releases.json file, or "-" to read from stdin')
    .option("--json", "Machine-readable JSON output")
    .addHelpText(
      "after",
      `
Examples:
  $ releases json validate releases.json
  $ releases json validate ./path/to/.well-known/releases.json --json
  $ cat releases.json | releases json validate -

Validates either hosting scope (domain-hosted /.well-known/releases.json or a
repo-root releases.json). Exit code 0 when valid, 1 when invalid.

A bare hostname (e.g. acme.com) targets the domain form — validates live
against the registry's listing endpoint and prints the materialization plan.
Docs: https://releases.sh/docs/listing`,
    )
    .action(async (target: string, opts: { json?: boolean }) => {
      await runValidate(target, opts);
    });

  json
    .command("export")
    .description("Generate a releases.json manifest from an already-tracked org")
    .argument("<org>", "Org slug (e.g. vercel)")
    .option("-o, --output <file>", "Write to a file instead of stdout")
    .addHelpText(
      "after",
      `
Examples:
  $ releases json export vercel
  $ releases json export vercel -o .well-known/releases.json
  $ releases json export vercel | releases json validate -

Reconstructs the domain-scope manifest from what the registry already tracks
for the org (products + release sources) — a starter you can host at
/.well-known/releases.json to own your listing. Re-ingest ENRICHES missing
fields only (fill-if-empty); it never overwrites existing values.
Docs: https://releases.sh/docs/listing`,
    )
    .action(async (org: string, opts: { output?: string }) => {
      await runExport(org, opts);
    });
}
