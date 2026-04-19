# Organizations Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add organizations that group changelog sources by company, with domain/account lookup and CLI/MCP support.

**Architecture:** New `organizations` and `org_accounts` tables with optional FK from `sources`. A shared `findOrg()` resolver provides multi-field lookup. CLI gets an `org` subcommand group; existing commands gain `--org` filters. MCP tools gain an `organization` parameter.

**Tech Stack:** SQLite (Drizzle ORM), nanoid IDs (`org_`, `oa_` prefixes), Commander CLI, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-03-26-organizations-design.md`

---

## File Structure

### New files

- `src/cli/commands/org.ts` — all `released org` subcommands (add, list, show, remove, link, unlink)

### Modified files

- `src/lib/id.ts` — add `newOrgId()` and `newOrgAccountId()` generators
- `src/db/schema.ts` — add `organizations` and `orgAccounts` tables, add `orgId` to `sources`
- `src/db/migrate.ts` — v1→v2 migration block
- `src/db/queries.ts` — add `findOrg()`, `getSourcesByOrg()`, `getRecentReleasesByOrg()`, `listOrgs()`
- `src/cli/commands/add.ts` — add `--org` flag and GitHub auto-association
- `src/cli/commands/latest.ts` — add `--org` filter
- `src/cli/commands/search.ts` — add `--org` filter
- `src/cli/commands/summary.ts` — add `--org` filter using `getRecentReleasesByOrg()`
- `src/cli/commands/list.ts` — show org name in source table
- `src/cli/program.ts` — register org command
- `src/mcp/server.ts` — add `list_organizations` tool, add `organization` param to existing tools

---

## Chunk 1: Schema, Migration, IDs, and Query Helpers

### Task 1: Add nanoid generators for orgs

**Files:**

- Modify: `src/lib/id.ts`

- [ ] **Step 1: Add org ID generators**

```typescript
export const newOrgId = () => `org_${nanoid()}`;
export const newOrgAccountId = () => `oa_${nanoid()}`;
```

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/lib/id.ts
git commit -m "Add nanoid generators for organizations and org accounts"
```

---

### Task 2: Add schema tables and update sources

**Files:**

- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add organizations table**

**Depends on:** Task 1 (id generators must exist before schema references them).

Extend the existing import in `src/db/schema.ts` (line 2) to include the new generators:

```typescript
import { newSourceId, newReleaseId, newOrgId, newOrgAccountId } from "../lib/id.js";
```

Add after the existing `sources` table definition:

```typescript
export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey().$defaultFn(newOrgId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  domain: text("domain").unique(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
```

- [ ] **Step 2: Add org_accounts table**

```typescript
export const orgAccounts = sqliteTable(
  "org_accounts",
  {
    id: text("id").primaryKey().$defaultFn(newOrgAccountId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    handle: text("handle").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [uniqueIndex("idx_org_accounts_platform_handle").on(table.platform, table.handle)],
);
```

- [ ] **Step 3: Add orgId to sources table**

Add to the `sources` table definition:

```typescript
orgId: text("org_id").references(() => organizations.id, { onDelete: "set null" }),
```

Add an index in a second argument to `sqliteTable` for sources (convert to the tuple syntax):

```typescript
export const sources = sqliteTable(
  "sources",
  {
    // ... existing columns ...
    orgId: text("org_id").references(() => organizations.id, { onDelete: "set null" }),
  },
  (table) => [index("idx_sources_org").on(table.orgId)],
);
```

- [ ] **Step 4: Add type exports**

```typescript
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrgAccount = typeof orgAccounts.$inferSelect;
export type NewOrgAccount = typeof orgAccounts.$inferInsert;
```

- [ ] **Step 5: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts
git commit -m "Add organizations and org_accounts schema tables"
```

---

### Task 3: Add v1→v2 migration

**Files:**

- Modify: `src/db/migrate.ts`

- [ ] **Step 1: Add v2 migration block**

After the closing `}` of the v0→v1 `if` block (line 20), before the `// Create tables if they don't exist` comment (line 22), add:

```typescript
// v1 → v2: add organizations support
if (user_version < 2) {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      domain TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS org_accounts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      handle TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_accounts_platform_handle ON org_accounts(platform, handle)`,
  );

  try {
    db.run(
      sql`ALTER TABLE sources ADD COLUMN org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL`,
    );
  } catch {
    // Column already exists if migration ran partially
  }

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_sources_org ON sources(org_id)`);
  db.run(sql`PRAGMA user_version = 2`);
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Test migration runs without error**

Run: `bun src/index.ts list`
Expected: runs successfully (migration executes on startup), shows existing sources or "No sources configured."

- [ ] **Step 4: Commit**

```bash
git add src/db/migrate.ts
git commit -m "Add v1-to-v2 migration for organizations tables"
```

---

### Task 4: Add query helpers

**Files:**

- Modify: `src/db/queries.ts`

- [ ] **Step 1: Add findOrg resolver**

```typescript
import { organizations, orgAccounts, type Organization } from "./schema.js";
import { sql } from "drizzle-orm";

export async function findOrg(identifier: string): Promise<Organization | null> {
  const db = getDb();

  // 1. Slug (exact)
  const [bySlug] = await db.select().from(organizations).where(eq(organizations.slug, identifier));
  if (bySlug) return bySlug;

  // 2. Domain (exact)
  const [byDomain] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.domain, identifier));
  if (byDomain) return byDomain;

  // 3. Name (case-insensitive, oldest first for determinism)
  const [byName] = await db
    .select()
    .from(organizations)
    .where(sql`LOWER(${organizations.name}) = LOWER(${identifier})`)
    .orderBy(organizations.createdAt)
    .limit(1);
  if (byName) return byName;

  // 4. Account handle (exact)
  const [byHandle] = await db
    .select({ org: organizations })
    .from(orgAccounts)
    .innerJoin(organizations, eq(orgAccounts.orgId, organizations.id))
    .where(eq(orgAccounts.handle, identifier));
  if (byHandle) return byHandle.org;

  return null;
}
```

- [ ] **Step 2: Add getSourcesByOrg**

```typescript
export async function getSourcesByOrg(orgId: string): Promise<Source[]> {
  const db = getDb();
  return db.select().from(sources).where(eq(sources.orgId, orgId));
}
```

- [ ] **Step 3: Add getRecentReleasesByOrg**

```typescript
export async function getRecentReleasesByOrg(
  orgId: string,
  cutoffIso: string,
): Promise<Array<Release & { sourceName: string; sourceSlug: string }>> {
  const db = getDb();
  const rows = await db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      version: releases.version,
      title: releases.title,
      content: releases.content,
      contentSummary: releases.contentSummary,
      url: releases.url,
      contentHash: releases.contentHash,
      metadata: releases.metadata,
      publishedAt: releases.publishedAt,
      fetchedAt: releases.fetchedAt,
      sourceName: sources.name,
      sourceSlug: sources.slug,
    })
    .from(releases)
    .innerJoin(sources, eq(releases.sourceId, sources.id))
    .where(and(eq(sources.orgId, orgId), gte(releases.publishedAt, cutoffIso)))
    .orderBy(desc(releases.publishedAt));
  return rows;
}
```

- [ ] **Step 4: Add listOrgs shared helper**

This helper is used by both `org list` CLI and `list_organizations` MCP tool (CLAUDE.md convention: shared DB query helpers live in `src/db/queries.ts`).

```typescript
export async function listOrgs(opts?: {
  query?: string;
  platform?: string;
}): Promise<Organization[]> {
  const db = getDb();
  let allOrgs = await db.select().from(organizations);

  if (opts?.platform) {
    const accountOrgIds = await db
      .select({ orgId: orgAccounts.orgId })
      .from(orgAccounts)
      .where(eq(orgAccounts.platform, opts.platform));
    const orgIdSet = new Set(accountOrgIds.map((a) => a.orgId));
    allOrgs = allOrgs.filter((o) => orgIdSet.has(o.id));
  }

  if (opts?.query) {
    const q = opts.query.toLowerCase();
    const accounts = await db.select().from(orgAccounts);
    const orgIdsWithMatchingHandle = new Set(
      accounts.filter((a) => a.handle.toLowerCase().includes(q)).map((a) => a.orgId),
    );
    allOrgs = allOrgs.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        o.slug.toLowerCase().includes(q) ||
        (o.domain && o.domain.toLowerCase().includes(q)) ||
        orgIdsWithMatchingHandle.has(o.id),
    );
  }

  return allOrgs;
}
```

- [ ] **Step 5: Update imports at top of file**

Make sure the imports include everything needed:

```typescript
import { eq, desc, gte, and, sql } from "drizzle-orm";
import { getDb } from "./connection.js";
import {
  sources,
  releases,
  organizations,
  orgAccounts,
  type Source,
  type Release,
  type Organization,
} from "./schema.js";
```

- [ ] **Step 6: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add src/db/queries.ts
git commit -m "Add findOrg, getSourcesByOrg, and getRecentReleasesByOrg query helpers"
```

---

## Chunk 2: CLI — Org Commands

### Task 5: Create org subcommand group

**Files:**

- Create: `src/cli/commands/org.ts`
- Modify: `src/cli/program.ts`

- [ ] **Step 1: Create org.ts with `org add` subcommand**

```typescript
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { organizations, orgAccounts } from "../../db/schema.js";
import { findOrg, getSourcesByOrg, listOrgs } from "../../db/queries.js";
import { toSlug } from "../../lib/slug.js";

export function registerOrgCommand(program: Command) {
  const org = program.command("org").description("Manage organizations");

  // ── org add ──
  org
    .command("add")
    .description("Add a new organization")
    .argument("<name>", "Organization name")
    .option("--domain <domain>", "Primary domain (e.g. vercel.com)")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: { domain?: string; slug?: string; json?: boolean }) => {
      const db = getDb();
      const slug = opts.slug ?? toSlug(name);

      const existing = await findOrg(slug);
      if (existing) {
        console.error(chalk.red(`Organization with slug "${slug}" already exists.`));
        process.exit(1);
      }

      const now = new Date().toISOString();
      const [created] = await db
        .insert(organizations)
        .values({
          name,
          slug,
          domain: opts.domain ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (opts.json) {
        console.log(JSON.stringify(created, null, 2));
      } else {
        console.log(chalk.green(`Organization added: ${name} (${slug})`));
      }
    });

  // ── org list ──
  org
    .command("list")
    .description("List all organizations")
    .option("--query <text>", "Filter by name, slug, domain, or account handle")
    .option("--platform <platform>", "Filter to orgs with an account on this platform")
    .option("--json", "Output as JSON")
    .action(async (opts: { query?: string; platform?: string; json?: boolean }) => {
      const allOrgs = await listOrgs({ query: opts.query, platform: opts.platform });

      if (allOrgs.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify([], null, 2));
        } else {
          console.log(chalk.yellow("No organizations found."));
        }
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(allOrgs, null, 2));
        return;
      }

      const table = new Table({
        head: [chalk.cyan("Name"), chalk.cyan("Slug"), chalk.cyan("Domain"), chalk.cyan("Updated")],
      });

      for (const o of allOrgs) {
        table.push([o.name, o.slug, o.domain ?? chalk.dim("—"), o.updatedAt]);
      }

      console.log(table.toString());
    });

  // ── org show ──
  org
    .command("show")
    .description("Show organization details")
    .argument("<identifier>", "Org slug, domain, name, or account handle")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        console.error(chalk.red(`Organization not found: ${identifier}`));
        process.exit(1);
      }

      const db = getDb();
      const accounts = await db.select().from(orgAccounts).where(eq(orgAccounts.orgId, found.id));
      const linkedSources = await getSourcesByOrg(found.id);

      if (opts.json) {
        console.log(JSON.stringify({ ...found, accounts, sources: linkedSources }, null, 2));
        return;
      }

      console.log(chalk.bold(found.name));
      console.log(`  Slug:    ${found.slug}`);
      console.log(`  Domain:  ${found.domain ?? chalk.dim("—")}`);
      console.log(`  Created: ${found.createdAt}`);
      console.log(`  Updated: ${found.updatedAt}`);

      if (accounts.length > 0) {
        console.log();
        console.log(chalk.bold("Accounts:"));
        for (const a of accounts) {
          console.log(`  ${chalk.cyan(a.platform)}  ${a.handle}`);
        }
      }

      if (linkedSources.length > 0) {
        console.log();
        console.log(chalk.bold("Sources:"));
        for (const s of linkedSources) {
          console.log(`  ${chalk.cyan(s.slug)}  ${s.name}  (${s.type})`);
        }
      }
    });

  // ── org remove ──
  org
    .command("remove")
    .description("Remove an organization")
    .argument("<identifier>", "Org slug, domain, name, or account handle")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        console.error(chalk.red(`Organization not found: ${identifier}`));
        process.exit(1);
      }

      const db = getDb();
      await db.delete(organizations).where(eq(organizations.id, found.id));

      if (opts.json) {
        console.log(JSON.stringify({ removed: found.slug }, null, 2));
      } else {
        console.log(chalk.green(`Removed organization: ${found.name} (${found.slug})`));
      }
    });

  // ── org link ──
  org
    .command("link")
    .description("Link a platform account to an organization")
    .argument("<identifier>", "Org slug, domain, name, or account handle")
    .requiredOption("--platform <platform>", "Platform name (github, x, linkedin, etc.)")
    .requiredOption("--handle <handle>", "Account handle on the platform")
    .option("--json", "Output as JSON")
    .action(
      async (identifier: string, opts: { platform: string; handle: string; json?: boolean }) => {
        const found = await findOrg(identifier);
        if (!found) {
          console.error(chalk.red(`Organization not found: ${identifier}`));
          process.exit(1);
        }

        const db = getDb();
        const [created] = await db
          .insert(orgAccounts)
          .values({
            orgId: found.id,
            platform: opts.platform,
            handle: opts.handle,
          })
          .returning();

        await db
          .update(organizations)
          .set({ updatedAt: new Date().toISOString() })
          .where(eq(organizations.id, found.id));

        if (opts.json) {
          console.log(JSON.stringify(created, null, 2));
        } else {
          console.log(chalk.green(`Linked ${opts.platform}/${opts.handle} to ${found.name}`));
        }
      },
    );

  // ── org unlink ──
  org
    .command("unlink")
    .description("Remove a platform account from an organization")
    .argument("<identifier>", "Org slug, domain, name, or account handle")
    .requiredOption("--platform <platform>", "Platform name")
    .requiredOption("--handle <handle>", "Account handle")
    .action(async (identifier: string, opts: { platform: string; handle: string }) => {
      const found = await findOrg(identifier);
      if (!found) {
        console.error(chalk.red(`Organization not found: ${identifier}`));
        process.exit(1);
      }

      const db = getDb();
      const deleted = await db
        .delete(orgAccounts)
        .where(
          and(
            eq(orgAccounts.orgId, found.id),
            eq(orgAccounts.platform, opts.platform),
            eq(orgAccounts.handle, opts.handle),
          ),
        );

      await db
        .update(organizations)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(organizations.id, found.id));

      console.log(chalk.green(`Unlinked ${opts.platform}/${opts.handle} from ${found.name}`));
    });
}
```

- [ ] **Step 2: Register in program.ts**

Add to `src/cli/program.ts`:

```typescript
import { registerOrgCommand } from "./commands/org.js";
// ... after other registrations:
registerOrgCommand(program);
```

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Smoke test org commands**

Run: `bun src/index.ts org add "Vercel" --domain vercel.com`
Expected: `Organization added: Vercel (vercel)`

Run: `bun src/index.ts org link vercel --platform github --handle vercel`
Expected: `Linked github/vercel to Vercel`

Run: `bun src/index.ts org show vercel`
Expected: shows Vercel details with the github account

Run: `bun src/index.ts org list`
Expected: table with Vercel row

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/org.ts src/cli/program.ts
git commit -m "Add org CLI subcommands: add, list, show, remove, link, unlink"
```

---

## Chunk 3: Source Command Changes and Auto-Association

### Task 6: Add --org flag to `released add` with auto-association

**Files:**

- Modify: `src/cli/commands/add.ts`

- [ ] **Step 1: Rewrite add.ts with --org flag and GitHub auto-association**

Replace the entire contents of `src/cli/commands/add.ts` with:

```typescript
import { Command } from "commander";
import chalk from "chalk";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, organizations, orgAccounts } from "../../db/schema.js";
import { findOrg } from "../../db/queries.js";
import { toSlug } from "../../lib/slug.js";
import { logger } from "../../lib/logger.js";

const VALID_TYPES = ["github", "scrape"] as const;
type SourceType = (typeof VALID_TYPES)[number];

function isValidType(t: string): t is SourceType {
  return (VALID_TYPES as readonly string[]).includes(t);
}

function parseGitHubOwner(url: string): string | null {
  const match = url.match(/github\.com\/([^/]+)\//);
  return match ? match[1] : null;
}

export function registerAddCommand(program: Command) {
  program
    .command("add")
    .description("Add a new changelog source")
    .argument("<name>", "Display name for the source")
    .requiredOption("--type <type>", "Source type: github or scrape")
    .requiredOption("--url <url>", "URL of the source")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .option("--org <org>", "Organization name or slug (creates if not found)")
    .action(
      async (name: string, opts: { type: string; url: string; slug?: string; org?: string }) => {
        if (!isValidType(opts.type)) {
          console.error(
            chalk.red(`Invalid type "${opts.type}". Must be one of: ${VALID_TYPES.join(", ")}`),
          );
          process.exit(1);
        }

        const slug = opts.slug ?? toSlug(name);
        const db = getDb();
        let orgId: string | null = null;

        // Resolve or create org if --org provided
        if (opts.org) {
          let org = await findOrg(opts.org);
          if (!org) {
            const orgSlug = toSlug(opts.org);
            org = await findOrg(orgSlug);
            if (!org) {
              const now = new Date().toISOString();
              const [created] = await db
                .insert(organizations)
                .values({
                  name: opts.org,
                  slug: orgSlug,
                  createdAt: now,
                  updatedAt: now,
                })
                .returning();
              org = created;
              logger.info(`Created organization: ${org.name} (${org.slug})`);
            }
          }
          orgId = org.id;
        }

        // Auto-association for GitHub sources (only if no --org specified)
        if (!opts.org && opts.type === "github") {
          const owner = parseGitHubOwner(opts.url);
          if (owner) {
            const [account] = await db
              .select()
              .from(orgAccounts)
              .where(and(eq(orgAccounts.platform, "github"), eq(orgAccounts.handle, owner)));
            if (account) {
              orgId = account.orgId;
              const org = await findOrg(account.orgId);
              logger.info(`Auto-linked to organization "${org?.name ?? account.orgId}"`);
            }
          }
        }

        await db.insert(sources).values({
          name,
          slug,
          type: opts.type,
          url: opts.url,
          orgId,
        });

        const orgLabel = orgId ? ` [org: ${opts.org}]` : "";
        console.log(chalk.green(`Source added: ${name} (${slug})${orgLabel}`));
      },
    );
}
```

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Test --org flag**

Run: `bun src/index.ts add "Next.js" --type github --url https://github.com/vercel/next.js --org vercel`
Expected: `Source added: Next.js (next-js) [org: vercel]` — links to existing Vercel org

Run: `bun src/index.ts add "Linear" --type scrape --url https://linear.app/changelog --org Linear`
Expected: creates stub org "Linear" and links the source

- [ ] **Step 5: Test auto-association**

Run: `bun src/index.ts add "Turbopack" --type github --url https://github.com/vercel/turbopack`
Expected: auto-links to Vercel org (because github/vercel account exists), logs `Auto-linked to organization "Vercel"`

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/add.ts
git commit -m "Add --org flag and GitHub auto-association to source add command"
```

---

## Chunk 4: Query Command --org Filters

### Task 7: Add --org filter to latest command

**Files:**

- Modify: `src/cli/commands/latest.ts`

- [ ] **Step 1: Add --org option**

Add imports and option:

```typescript
import { inArray } from "drizzle-orm";
import { findOrg } from "../../db/queries.js";
```

Add `.option("--org <identifier>", "Filter to an organization")` to the command chain. Update the opts type to include `org?: string`.

Update the action to resolve org and filter:

```typescript
// After existing slug handling, before the query:
let orgSourceIds: string[] | undefined;
if (opts.org) {
  const org = await findOrg(opts.org);
  if (!org) {
    console.error(chalk.red(`Organization not found: ${opts.org}`));
    process.exit(1);
  }
  const orgSources = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.orgId, org.id));
  orgSourceIds = orgSources.map((s) => s.id);
}
```

Then add a `.where()` clause using `inArray(releases.sourceId, orgSourceIds)` when `orgSourceIds` is defined.

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/latest.ts
git commit -m "Add --org filter to latest command"
```

---

### Task 8: Add --org filter to search command

**Files:**

- Modify: `src/cli/commands/search.ts`

- [ ] **Step 1: Add --org option**

Add import:

```typescript
import { findOrg, getSourcesByOrg } from "../../db/queries.js";
```

Add `.option("--org <identifier>", "Filter to an organization")` to the command chain.

After getting FTS results, if `--org` is provided, resolve the org, get its source IDs, and filter results to only those whose `sourceId` belongs to the org's sources. This uses the same batch lookup pattern already in the command.

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/search.ts
git commit -m "Add --org filter to search command"
```

---

### Task 9: Add --org filter to summary command

**Files:**

- Modify: `src/cli/commands/summary.ts`

- [ ] **Step 1: Add --org as alternative to slug argument**

The summary command currently requires a `<slug>` argument for a single source. Add `--org` as an alternative that summarizes across all of an org's sources:

```typescript
import { findOrg, getRecentReleasesByOrg } from "../../db/queries.js";
```

Make the `<slug>` argument optional. If `--org` is provided instead, use `getRecentReleasesByOrg()`. The release-to-AI-input mapping should include the source name for attribution when in org mode.

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/summary.ts
git commit -m "Add --org filter to summary command"
```

---

### Task 10: Show org name in source list

**Files:**

- Modify: `src/cli/commands/list.ts`

- [ ] **Step 1: Join organizations in list query**

Update the query to left-join organizations and show the org name in the table:

```typescript
import { eq } from "drizzle-orm";
import { sources, organizations } from "../../db/schema.js";

// Replace: const allSources = await db.select().from(sources);
// With:
const allSources = await db
  .select({
    id: sources.id,
    name: sources.name,
    slug: sources.slug,
    type: sources.type,
    url: sources.url,
    lastFetchedAt: sources.lastFetchedAt,
    orgName: organizations.name,
  })
  .from(sources)
  .leftJoin(organizations, eq(sources.orgId, organizations.id));
```

Add "Org" column to the table head and row output.

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/list.ts
git commit -m "Show organization name in source list output"
```

---

## Chunk 5: MCP Tool Changes

### Task 11: Add list_organizations MCP tool and org filters to existing tools

**Files:**

- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Add list_organizations tool**

After the existing `list_products` tool registration, add:

```typescript
server.registerTool(
  "list_organizations",
  {
    description: "List all indexed organizations, optionally filtered",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Search across org name, slug, domain, and account handles"),
      platform: z.string().optional().describe("Filter to orgs with an account on this platform"),
    },
  },
  async ({ query, platform }) => {
    const allOrgs = await listOrgs({ query, platform });

    if (allOrgs.length === 0) {
      return textResult("No organizations found.");
    }

    const text = allOrgs
      .map((o) =>
        [`**${o.name}**`, `  Slug: ${o.slug}`, `  Domain: ${o.domain ?? "N/A"}`].join("\n"),
      )
      .join("\n\n");

    return textResult(text);
  },
);
```

- [ ] **Step 2: Add organization parameter to list_products**

Add `organization: z.string().optional().describe("Filter to sources belonging to this organization")` to the `list_products` input schema.

In the handler, if `organization` is provided, resolve via `findOrg()` and filter sources by org.

- [ ] **Step 3: Add organization parameter to search_releases**

Add `organization` parameter. If provided, resolve org, get source IDs, filter FTS results.

- [ ] **Step 4: Add organization parameter to get_latest_releases**

Add `organization` parameter. If provided, resolve org and use it as an additional filter alongside the existing product filter.

- [ ] **Step 5: Add necessary imports**

```typescript
import { organizations, orgAccounts } from "../db/schema.js";
import { findOrg, getSourcesByOrg, listOrgs } from "../db/queries.js";
```

- [ ] **Step 6: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts
git commit -m "Add list_organizations MCP tool and org filters to existing tools"
```

---

## Chunk 6: Final Verification

### Task 12: End-to-end smoke test and cleanup

- [ ] **Step 1: Run full type-check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 2: End-to-end test**

```bash
# Create org with domain and accounts
bun src/index.ts org add "Vercel" --domain vercel.com
bun src/index.ts org link vercel --platform github --handle vercel
bun src/index.ts org link vercel --platform x --handle vercel

# Add sources — one with --org, one with auto-association
bun src/index.ts add "Next.js" --type github --url https://github.com/vercel/next.js --org vercel
bun src/index.ts add "Turbopack" --type github --url https://github.com/vercel/turbopack
# Turbopack should auto-link to Vercel

# Verify
bun src/index.ts org show vercel
# Should show domain, 2 accounts, 2 sources

bun src/index.ts list
# Should show Org column with "Vercel" for both sources

bun src/index.ts org list
# Should show Vercel with domain

bun src/index.ts org list --platform github
# Should show Vercel

bun src/index.ts org list --query "next"
# Should show nothing (query matches sources, not org)

bun src/index.ts org list --query "vercel"
# Should show Vercel
```

- [ ] **Step 3: Run simplify review**

Use `/simplify` to review all changes across the org implementation.

- [ ] **Step 4: Final commit if simplify made changes**

```bash
git add -A
git commit -m "Simplify review fixes for organizations feature"
```
