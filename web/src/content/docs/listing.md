---
title: "Get Listed — releases.json"
description: "Own how you appear in the Releases registry with releases.json. An open, host-verified standard for declaring your name, description, category, avatar, social links, and product grouping — no account or claim flow required."
adminOnly: false
---

# Get Listed

Releases indexes the open web — GitHub releases, CHANGELOG files, release-notes pages, and feeds — and normalizes them into one registry. `releases.json` is the open standard for telling that registry how you want to appear, so agents and humans represent you correctly.

There's no account to create and no listing to claim. Authority comes from **where the file lives**: a file on your domain speaks for your org, a file in a repo speaks for that repo's source. If you can publish a file at a URL, you can control the listing it's authoritative for.

## Two files, two scopes

| File                        | Where you host it                                                 | What it controls                                                                       |
| --------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `.well-known/releases.json` | `https://yourdomain.com/.well-known/releases.json`                | Your **org identity**: name, description, category, avatar, tags, social links, notice |
| `releases.json`             | The **root of a repo** (e.g. `github.com/you/repo/releases.json`) | That source's **product**: name, slug, and optional description/category/kind          |

A domain file can't define a product, and a repo file can't define your org — each scope is limited to what its host can legitimately speak for. Two repos that declare the same product `slug` get grouped under one product, which is how you tie multiple changelogs into a single product page.

## Org identity — `.well-known/releases.json`

Host this at `https://yourdomain.com/.well-known/releases.json`:

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "name": "Acme",
  "description": "CI for teams that ship.",
  "category": "developer-tools",
  "avatar": "https://acme.com/logo.png",
  "tags": ["ci", "observability"],
  "social": { "twitter": "acmehq", "github": "acme" },
  "notice": { "message": "Docs moved", "href": "https://acme.com/docs" }
}
```

## Product mapping — `releases.json` in a repo root

Host this at the root of the repo whose releases we index (e.g. `github.com/acme/cloud/releases.json`):

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "product": {
    "name": "Acme Cloud",
    "slug": "acme-cloud",
    "category": "cloud",
    "kind": "platform"
  }
}
```

The `$schema` line is optional but recommended — editors that understand JSON Schema will validate the file and autocomplete fields against [the published schema](https://releases.sh/schemas/releases.json).

## What we honor — and what we never touch

`releases.json` is **fill-if-empty and fails closed**, so it's safe to add and safe to leave in place:

- A field is owner-writable only if it's empty or was previously set by your own `releases.json`. We won't overwrite a value a curator set by hand, and the org `name` is never overwritten once it exists.
- Curator and editorial decisions — whether you're featured, hidden, your collections, blocked/ignored URLs, which source is primary — are never affected by your file.
- `category` is matched against the known category list; an unrecognized value is ignored rather than failing the sync.
- Tags and social links are additive in this version (we add what's new; removing an entry from the file doesn't remove it from the listing yet).
- A missing, invalid, oversized, or unreachable file is a no-op. A broken file never breaks your listing.

## How it gets picked up

Once your source is in the registry, we re-read your `releases.json` on a regular sweep, so edits show up without you doing anything else. If your org or product isn't indexed yet, [submit the URL](/submit) first — then add a `releases.json` to shape how it appears.
