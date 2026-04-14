import { Command } from "commander";
import chalk from "chalk";
import { findSource, findOrg, findProduct, getRelease } from "../../db/queries.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { getEntityType, normalizeReleaseId } from "../../lib/id.js";

export function registerShowCommand(program: Command) {
  program
    .command("show")
    .description("Show details for any entity by ID or slug")
    .argument("<identifier>", "ID (rel_/src_/org_/prod_) or slug")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases show rel_XqbzLaOqBFz7VSAIqx2zs
  releases show src_abc123
  releases show org_abc123
  releases show prod_abc123
  releases show vercel                          # slug falls through org/product/source

Dispatches to the right entity based on ID prefix. For deeper views use
the nested commands: "list <src>", "org show <slug>", "product list <org>",
"release show <id>".`)
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const type = getEntityType(identifier);

      if (type === "release" || (type === "unknown" && looksLikeBareNanoid(identifier))) {
        return showRelease(normalizeReleaseId(identifier), opts);
      }
      if (type === "source") return showSource(identifier, opts);
      if (type === "org") return showOrg(identifier, opts);
      if (type === "product") return showProduct(identifier, opts);

      // Unknown prefix — treat as slug, try org → product → source in order.
      const org = await findOrg(identifier);
      if (org) return renderOrg(org, opts);
      const product = await findProduct(identifier);
      if (product) return renderProduct(product, opts);
      const source = await findSource(identifier);
      if (source) return renderSource(source, opts);

      console.error(chalk.red(`Not found: ${identifier}`));
      console.error(chalk.dim(`Make sure you're using a fully-resolved ID (rel_…, src_…, org_…, prod_…) or a valid slug.`));
      process.exit(1);
    });
}

function looksLikeBareNanoid(input: string): boolean {
  return /^[A-Za-z0-9_-]{21}$/.test(input.trim());
}

async function showRelease(id: string, opts: { json?: boolean }) {
  const result = await getRelease(id);
  if (!result) {
    console.error(chalk.red(`Release not found: ${id}`));
    console.error(chalk.dim(`Make sure you're using the fully-resolved ID (e.g. rel_abc123…).`));
    process.exit(1);
  }
  const { release: rel, sourceName, sourceSlug } = result;
  if (opts.json) {
    console.log(JSON.stringify({ ...rel, sourceName, sourceSlug }, null, 2));
    return;
  }
  console.log(chalk.dim("Release"));
  console.log(chalk.bold(stripAnsi(rel.title)));
  console.log(`  ID:        ${rel.id}`);
  if (rel.version) console.log(`  Version:   ${stripAnsi(rel.version)}`);
  console.log(`  Source:    ${sourceName ? stripAnsi(sourceName) : chalk.dim("—")} (${sourceSlug ?? chalk.dim("—")})`);
  if (rel.publishedAt) console.log(`  Published: ${rel.publishedAt}`);
  if (rel.url) console.log(`  URL:       ${rel.url}`);
  if (rel.suppressed) {
    console.log(`  ${chalk.yellow("Suppressed")}${rel.suppressedReason ? `: ${stripAnsi(rel.suppressedReason)}` : ""}`);
  }
  console.log(chalk.dim(`\n  Run "releases admin release show ${rel.id}" for full content.`));
}

async function showSource(identifier: string, opts: { json?: boolean }) {
  const source = await findSource(identifier);
  if (!source) {
    console.error(chalk.red(`Source not found: ${identifier}`));
    console.error(chalk.dim(`Make sure you're using the fully-resolved ID (e.g. src_abc123…) or a valid slug.`));
    process.exit(1);
  }
  renderSource(source, opts);
}

async function showOrg(identifier: string, opts: { json?: boolean }) {
  const org = await findOrg(identifier);
  if (!org) {
    console.error(chalk.red(`Organization not found: ${identifier}`));
    console.error(chalk.dim(`Make sure you're using the fully-resolved ID (e.g. org_abc123…) or a valid slug.`));
    process.exit(1);
  }
  renderOrg(org, opts);
}

async function showProduct(identifier: string, opts: { json?: boolean }) {
  const product = await findProduct(identifier);
  if (!product) {
    console.error(chalk.red(`Product not found: ${identifier}`));
    console.error(chalk.dim(`Make sure you're using the fully-resolved ID (e.g. prod_abc123…) or a valid slug.`));
    process.exit(1);
  }
  renderProduct(product, opts);
}

function renderSource(source: { id: string; name: string; slug: string; type: string; url: string; orgId: string | null; productId: string | null }, opts: { json?: boolean }) {
  if (opts.json) {
    console.log(JSON.stringify(source, null, 2));
    return;
  }
  console.log(chalk.dim("Source"));
  console.log(chalk.bold(source.name));
  console.log(`  ID:        ${source.id}`);
  console.log(`  Slug:      ${source.slug}`);
  console.log(`  Type:      ${source.type}`);
  console.log(`  URL:       ${source.url}`);
  console.log(chalk.dim(`\n  Run "releases list ${source.slug}" for full details.`));
}

function renderOrg(org: { id: string; name: string; slug: string; domain: string | null; category: string | null }, opts: { json?: boolean }) {
  if (opts.json) {
    console.log(JSON.stringify(org, null, 2));
    return;
  }
  console.log(chalk.dim("Organization"));
  console.log(chalk.bold(org.name));
  console.log(`  ID:        ${org.id}`);
  console.log(`  Slug:      ${org.slug}`);
  console.log(`  Domain:    ${org.domain ?? chalk.dim("—")}`);
  console.log(`  Category:  ${org.category ?? chalk.dim("—")}`);
  console.log(chalk.dim(`\n  Run "releases admin org show ${org.slug}" for full details.`));
}

function renderProduct(product: { id: string; name: string; slug: string; orgId: string; url: string | null; category: string | null }, opts: { json?: boolean }) {
  if (opts.json) {
    console.log(JSON.stringify(product, null, 2));
    return;
  }
  console.log(chalk.dim("Product"));
  console.log(chalk.bold(product.name));
  console.log(`  ID:        ${product.id}`);
  console.log(`  Slug:      ${product.slug}`);
  console.log(`  Org:       ${product.orgId}`);
  console.log(`  URL:       ${product.url ?? chalk.dim("—")}`);
  console.log(`  Category:  ${product.category ?? chalk.dim("—")}`);
  console.log(chalk.dim(`\n  Run "releases admin product list ${product.orgId}" to see siblings.`));
}
