---
title: "Get Listed — releases.json"
description: "One small file that tells the Releases registry — and any agent — where you publish product updates. Point at your changelog, feed, or GitHub releases, and optionally break it down by product."
adminOnly: false
---

# Get Listed

Every company posts product updates somewhere — a changelog, an updates page, a blog, GitHub releases, an RSS feed. `releases.json` is one small file on your domain that says where. Publish it once, and any registry or agent that reads the format — starting with this one — learns where your release notes live directly from you, instead of guessing.

There's no account to create and no listing to claim. Authority comes from **where the file lives**: a file on your domain speaks for your company, and a file in a repo speaks for that repo. If you can publish a file at a URL, you can control what it declares.

The format is deliberately **not ours**. We aren't aware of an existing standard for declaring where release notes live, so this file states plain facts about your domain — your products and the places you publish updates — in terms any registry, feed reader, or agent can consume. Nothing in it binds you to this registry except the optional `registries` block described below, which is namespaced so other tools can add their own. If a real standard emerges, we'd rather read that; until then, publish once and let anyone benefit.

## The simplest useful file

Host this at `https://yourdomain.com/.well-known/releases.json`:

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "version": 2,
  "releases": [{ "url": "https://updates.acme.com", "feed": "https://updates.acme.com/rss.xml" }]
}
```

That's a complete manifest. It says: _here's where we post product updates_ — the page people should read, and the feed machines should follow. If you haven't broken your updates down by product, you don't have to. This is enough.

Each entry in `releases` is one place you publish updates, described with whichever keys fit:

| Key        | Use it for                                                                 |
| ---------- | -------------------------------------------------------------------------- |
| `url`      | The page a person would read — your changelog, updates page, or what's-new |
| `feed`     | The RSS/Atom feed for those updates, if you have one                       |
| `github`   | A GitHub repo whose Releases are the record — `"acme/cloud-sdk"`           |
| `appstore` | An App Store listing, for apps whose release notes live there              |
| `file`     | A raw changelog document at a URL, like a hosted `CHANGELOG.md`            |

Every entry needs at least one of those. You can also add a `title` to name a location, and mark one entry per scope with `"canonical": true` if you list several places and one is the primary.

## Growing into products

When one link isn't enough — you ship several products, each with its own changelog — add a `products` array. Root-level fields describe your company; each product carries its own details and locations:

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "version": 2,
  "name": "Acme",
  "description": "CI for teams that ship.",
  "category": "developer-tools",
  "avatar": "https://acme.com/logo.png",
  "social": { "github": "acme", "twitter": "acmehq" },
  "products": [
    {
      "name": "Acme Cloud",
      "description": "Managed CI runners.",
      "website": "https://acme.com/cloud",
      "docs": "https://docs.acme.com/cloud",
      "releases": [
        {
          "url": "https://acme.com/whats-new",
          "feed": "https://acme.com/whats-new/rss.xml",
          "canonical": true
        },
        { "github": "acme/cloud-sdk" }
      ]
    },
    { "name": "Acme Legacy Agent", "archived": true }
  ],
  "releases": [{ "url": "https://updates.acme.com" }]
}
```

A few things worth knowing:

- **Top-level `releases` and `products` coexist.** Plenty of companies have a combined firehose _and_ per-product feeds (Cloudflare, for one). Declare both; the registry handles the overlap.
- **Products take `description`, `website`, `docs`, `support`, and `social`** — useful when a product has its own site or social presence separate from the company's.
- **`"archived": true`** marks a discontinued product so it's presented as historical rather than active.
- **Company fields are optional.** `name`, `description`, `category`, `tags`, `avatar`, and `social` shape how you appear, but the file is useful with none of them — the locations are the point.

## In a repo

A `releases.json` at the root of a repo speaks for that repo. It can say which product the repo belongs to, and where its releases actually end up:

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "version": 2,
  "product": { "name": "Acme Cloud", "slug": "acme-cloud" },
  "releases": [{ "url": "https://acme.com/whats-new", "canonical": true }, { "github": "self" }]
}
```

Repos that declare the same product are grouped under one product page — that's how several changelogs roll up into a single product. `"github": "self"` means this repo's own GitHub Releases are the source of record; the external `url` says where those releases are announced for humans.

A repo file can't define your company identity, and a domain file can't speak for a repo it doesn't host — each file declares only what its location can legitimately vouch for.

## Let an agent write it

If an agent works in your codebase, you can hand this off entirely — this page and the schema are machine-readable. Paste this prompt:

```text
Create a releases.json manifest for this project so registries and agents can
find where we publish release notes.

1. Read the format at https://releases.sh/docs/listing.md and the JSON Schema
   at https://releases.sh/schemas/releases.json.
2. Search this codebase and our site for the places we actually publish
   product updates: changelog or what's-new pages, RSS/Atom feeds, GitHub
   repos with Releases, App Store listings, or a hosted CHANGELOG file.
   Verify every URL responds. Only declare locations that really exist —
   never guess or invent.
3. If this repo serves our website, write the file so it's served at
   /.well-known/releases.json: set "version": 2, add a releases[] array of
   the locations you found, and optionally our company fields (name,
   description, category, tags, avatar, social). Use products[] only if we
   have distinct products with separate release locations.
4. If this repo is a single product or library, write releases.json at the
   repo root instead, with an optional product block and a releases[] array.
   Use { "github": "self" } if this repo's GitHub Releases are the record.
5. Every releases[] entry needs at least one of: url, feed, github, appstore,
   file. If you list several locations, mark the primary one with
   "canonical": true.
6. Validate against the schema, confirm the JSON parses, and show me the file
   and the URL it will be served from before committing anything.
```

The prompt works with any agent that can read your project — the important part is step 2: the file should state where your release notes _actually_ live, not aspirationally.

## What happens after you publish

The registry re-reads your file on a regular sweep, so edits show up without you doing anything else. When it finds locations it doesn't already know about:

- **Feeds, GitHub repos, and App Store listings go live automatically** once a quick check confirms they're real (the feed parses, the repo exists).
- **Plain web pages are reviewed by a person first.** We never start crawling a page just because a file mentioned it.

And the file is safe to publish and leave in place:

- It's **fill-if-empty**: your declarations fill gaps in your listing, but never overwrite something a curator set by hand.
- Curator and editorial decisions — featuring, collections, which source is primary — are never affected by your file.
- `category`, `kind`, and `tags` are suggestions. An unrecognized value is ignored, never an error.
- A missing, invalid, oversized, or unreachable file is a no-op. A broken file never breaks your listing.

If your company isn't in the registry yet, [submit your changelog URL](/submit) — then publish the file to shape how you appear.

## Pinning your listing

Names change and URLs move, so the registry identifies your org and products by stable IDs. If you want your file bound to your exact registry records — not matched by URL — pin them in a `registries` block:

```json
{
  "registries": {
    "releases.sh": { "org": "org_abc123" }
  }
}
```

You'll find the IDs on your org and product pages. The block is namespaced by registry, so the same file can carry pins for other registries that adopt the format. A `verification` field is reserved here for linking a domain to an account — that flow is coming.

## Reference

- **`version: 2` is required.** Version-1 files (the old profile-only shape) are no longer read; the fields above are the current format.
- **Limits:** up to 24 products and 8 locations per product, and at most 32 release locations per file in total (the top-level `releases` array plus every product's locations combined).
- **`$schema` is optional but recommended** — editors that understand JSON Schema will validate and autocomplete your file against [the published schema](https://releases.sh/schemas/releases.json).
- **Live example:** this site publishes its own file at [releases.sh/.well-known/releases.json](https://releases.sh/.well-known/releases.json).
