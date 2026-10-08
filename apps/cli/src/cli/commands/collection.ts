import { Command } from "commander";
import chalk from "chalk";
import { renderTable } from "../render/table.js";
import {
  listCollections,
  getCollection,
  getCollectionReleases,
  createCollection,
  updateCollection,
  deleteCollection,
  replaceCollectionMembers,
  addCollectionMember,
  removeCollectionMember,
} from "../../api/collections.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { writeJson } from "../../lib/output.js";

type GlobalOpts = { json?: boolean };

function refToInput(ref: string): { orgId: string } | { orgSlug: string } {
  return ref.startsWith("org_") ? { orgId: ref } : { orgSlug: ref };
}

async function listAction(opts: GlobalOpts): Promise<void> {
  const rows = await listCollections();
  if (opts.json) {
    await writeJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(chalk.yellow("No collections."));
    return;
  }
  console.log(
    renderTable({
      head: [
        { label: "Slug", noTruncate: true },
        { label: "Name" },
        { label: "Members", noTruncate: true, alignRight: true },
        { label: "Description" },
      ],
      rows: rows.map((r) => [
        r.slug,
        r.name,
        String(r.memberCount),
        r.description ?? chalk.dim("—"),
      ]),
    }),
  );
}

async function getAction(slug: string, opts: GlobalOpts): Promise<void> {
  const detail = await getCollection(slug);
  if (!detail) {
    console.error(chalk.red(`Collection not found: ${slug}`));
    process.exit(1);
  }
  if (opts.json) {
    await writeJson(detail);
    return;
  }
  console.log(chalk.bold(detail.name) + chalk.dim(` (${detail.slug})`));
  if (detail.description) console.log(detail.description);
  console.log("");
  if (detail.orgs.length === 0) {
    console.log(chalk.dim("No member orgs."));
    return;
  }
  console.log(chalk.cyan(`${detail.orgs.length} ${detail.orgs.length === 1 ? "org" : "orgs"}:`));
  for (const o of detail.orgs) console.log(`  - ${o.name} ${chalk.dim(`(${o.slug})`)}`);
}

type ReleasesOpts = GlobalOpts & {
  limit?: string;
  cursor?: string;
  includePrereleases?: boolean;
};
async function releasesAction(slug: string, opts: ReleasesOpts): Promise<void> {
  const limit = opts.limit ? Number(opts.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    console.error(chalk.red(`Invalid --limit "${opts.limit}" (need an integer between 1 and 100)`));
    process.exit(1);
  }
  const result = await getCollectionReleases(slug, {
    limit,
    cursor: opts.cursor ?? null,
    includePrereleases: opts.includePrereleases,
  });
  if (!result) {
    if (opts.json) await writeJson(null);
    else console.error(chalk.red(`Collection not found: ${slug}`));
    process.exit(1);
  }
  if (opts.json) {
    await writeJson(result);
    return;
  }
  if (result.releases.length === 0) {
    console.log(chalk.yellow(`No releases yet in collection "${slug}".`));
    return;
  }
  console.log(
    renderTable({
      head: [
        { label: "ID", noTruncate: true },
        { label: "Org" },
        { label: "Source" },
        { label: "Title" },
        { label: "Version", noTruncate: true },
        { label: "Published", noTruncate: true },
      ],
      rows: result.releases.map((r) => [
        chalk.dim(r.id),
        `${r.org.name} ${chalk.dim(`(${r.org.slug})`)}`,
        `${r.source.name} ${chalk.dim(`(${r.source.slug})`)}`,
        stripAnsi(r.title),
        r.version ? stripAnsi(r.version) : chalk.dim("—"),
        r.publishedAt?.slice(0, 10) ?? chalk.dim("—"),
      ]),
    }),
  );
  if (result.pagination.nextCursor) {
    console.log("");
    console.log(
      chalk.dim(
        `More available. Pass --cursor "${result.pagination.nextCursor}" to continue (limit ${result.pagination.limit}).`,
      ),
    );
  }
}

type CreateOpts = GlobalOpts & { slug?: string; description?: string };
async function createAction(name: string, opts: CreateOpts): Promise<void> {
  const created = await createCollection({
    name,
    slug: opts.slug,
    description: opts.description,
  });
  if (opts.json) await writeJson(created);
  else console.log(chalk.green(`Created collection: ${created.name} (${created.slug})`));
}

type UpdateOpts = GlobalOpts & { name?: string; slug?: string; description?: string };
async function updateAction(slug: string, opts: UpdateOpts): Promise<void> {
  const patch: { name?: string; slug?: string; description?: string | null } = {};
  if (opts.name !== undefined) patch.name = opts.name;
  if (opts.slug !== undefined) patch.slug = opts.slug;
  if (opts.description !== undefined) patch.description = opts.description;
  if (Object.keys(patch).length === 0) {
    console.error(chalk.red("Nothing to update — pass --name, --slug, or --description."));
    process.exit(1);
  }
  const updated = await updateCollection(slug, patch);
  if (opts.json) await writeJson(updated);
  else console.log(chalk.green(`Updated collection: ${updated.name} (${updated.slug})`));
}

async function deleteAction(slug: string, opts: GlobalOpts): Promise<void> {
  await deleteCollection(slug);
  if (opts.json) await writeJson({ removed: slug });
  else console.log(chalk.green(`Deleted collection: ${slug}`));
}

async function memberAddAction(
  slug: string,
  org: string,
  opts: GlobalOpts & { position?: string },
): Promise<void> {
  let position: number | undefined;
  if (opts.position !== undefined) {
    const parsed = Number(opts.position);
    if (!Number.isInteger(parsed) || parsed < 0) {
      console.error(
        chalk.red(`Invalid --position "${opts.position}" (need a non-negative integer)`),
      );
      process.exit(1);
    }
    position = parsed;
  }
  const result = await addCollectionMember(slug, { ...refToInput(org), position });
  if (opts.json) await writeJson(result);
  else
    console.log(
      chalk.green(`Added ${org} to ${slug}`) + chalk.dim(` (position ${result.position})`),
    );
}

async function memberSetAction(slug: string, orgList: string, opts: GlobalOpts): Promise<void> {
  const orgs = orgList
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((ref) => refToInput(ref));
  if (orgs.length === 0) {
    console.error(chalk.red("Provide at least one org (comma-separated org_… or slug)."));
    process.exit(1);
  }
  const result = await replaceCollectionMembers(slug, orgs);
  if (opts.json) await writeJson(result);
  else
    console.log(
      chalk.green(`Set ${result.members.length} members on ${slug}`) + chalk.dim(` (in order)`),
    );
}

async function memberRemoveAction(slug: string, org: string, opts: GlobalOpts): Promise<void> {
  await removeCollectionMember(slug, org);
  if (opts.json) await writeJson({ removed: org });
  else console.log(chalk.green(`Removed ${org} from ${slug}`));
}

/** Wires `list` / `get` / `releases` onto a parent `collection` command. */
function attachReadSubcommands(collection: Command): void {
  collection
    .command("list")
    .description("List collections")
    .option("--json", "Output as JSON")
    .action(listAction);

  collection
    .command("get")
    .description("Show a collection's detail and member orgs")
    .argument("<slug>", "Collection slug")
    .option("--json", "Output as JSON")
    .action(getAction);

  collection
    .command("releases")
    .description("Show the cross-org release feed for a collection")
    .argument("<slug>", "Collection slug")
    .option("--limit <n>", "Slice size (default 20, max 100)")
    .option("--cursor <token>", "Continuation cursor from a prior call")
    .option("--include-prereleases", "Include alphas, betas, RCs (default: hide)")
    .option("--json", "Output as JSON")
    .action(releasesAction);
}

/**
 * Read-only collection commands — public, no admin gate. Registered at the
 * top-level program so anyone can browse collections without an API key.
 */
export function registerCollectionReadCommands(program: Command): Command {
  const collection = program
    .command("collection")
    .description("Browse curated collections (cross-org playlists)");
  attachReadSubcommands(collection);
  return collection;
}

export function registerCollectionCommand(program: Command) {
  const collection = program
    .command("collection")
    .description("Manage curated collections (cross-org playlists)");

  attachReadSubcommands(collection);

  collection
    .command("create")
    .description("Create a collection")
    .argument("<name>", "Display name")
    .option("--slug <slug>", "Custom slug (defaults to name → kebab)")
    .option("--description <text>", "Optional description")
    .option("--json", "Output as JSON")
    .action(createAction);

  collection
    .command("update")
    .description("Update a collection's name, slug, or description")
    .argument("<slug>", "Current slug")
    .option("--name <name>", "New name")
    .option("--slug <slug>", "New slug (rotates the URL)")
    .option("--description <text>", "New description (pass empty string to clear)")
    .option("--json", "Output as JSON")
    .action(updateAction);

  collection
    .command("delete")
    .description("Delete a collection (cascade-removes membership)")
    .argument("<slug>", "Collection slug")
    .option("--json", "Output as JSON")
    .action(deleteAction);

  const members = collection.command("members").description("Manage collection membership");

  members
    .command("add")
    .description("Add an org to a collection")
    .argument("<slug>", "Collection slug")
    .argument("<org>", "Org id (org_…) or slug")
    .option("--position <n>", "Position (default 0)")
    .option("--json", "Output as JSON")
    .action(memberAddAction);

  members
    .command("set")
    .description("Replace full membership atomically (positions follow input order)")
    .argument("<slug>", "Collection slug")
    .argument("<orgs>", "Comma-separated org refs (org_… or slugs)")
    .option("--json", "Output as JSON")
    .action(memberSetAction);

  members
    .command("remove")
    .description("Remove an org from a collection")
    .argument("<slug>", "Collection slug")
    .argument("<org>", "Org id (org_…) or slug")
    .option("--json", "Output as JSON")
    .action(memberRemoveAction);
}
