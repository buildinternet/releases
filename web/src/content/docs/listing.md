---
title: "Listing your product — releases.json"
description: "One small file that tells the Releases registry — and any agent — where you publish product updates. Point at your changelog, feed, or GitHub releases."
adminOnly: false
---

# Listing your product

`releases.json` is a small file on your domain that declares **where you publish product updates** — a changelog, feed, GitHub Releases, App Store listing, or hosted CHANGELOG. Authority comes from **where the file lives**: domain file → company; repo-root file → that repo.

When the file is live, [check and activate on the submit page](/submit).

## Fast track: let an agent write it

Install the skill, paste the prompt (swap in your website), publish the file it produces at `/.well-known/releases.json`, then activate:

```bash
npx skills add https://github.com/buildinternet/releases --skill creating-releases-json
```

```text
Create a releases.json manifest for our product so registries and agents can
find where we publish release notes.

1. Install the creating-releases-json skill:
   npx skills add https://github.com/buildinternet/releases --skill creating-releases-json
2. Follow that skill end-to-end: discover the real places we publish updates
   (changelog, feed, GitHub Releases, App Store, CHANGELOG file), write a
   valid v2 manifest, and show me the finished file plus the URL it should be
   served from (usually https://{domain}/.well-known/releases.json).
3. Only declare locations that actually exist — never invent URLs.

Our website is: <your website or domain>
```

Same install + prompt are on the [submit page](/submit) as one-click copy.

## Write it yourself

Host this at `https://yourdomain.com/.well-known/releases.json`:

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "version": 2,
  "releases": [{ "url": "https://updates.acme.com", "feed": "https://updates.acme.com/rss.xml" }]
}
```

Each `releases[]` entry needs **at least one** locator:

| Key        | Use it for                                              |
| ---------- | ------------------------------------------------------- |
| `url`      | Page a person reads (changelog / what's-new)            |
| `feed`     | RSS/Atom feed                                           |
| `github`   | Repo Releases — `"acme/cloud-sdk"` (or `"self"` in a repo file) |
| `appstore` | App Store listing                                       |
| `file`     | Hosted raw changelog (e.g. `CHANGELOG.md` URL)          |

Optional: `title` on a location; `"canonical": true` on the primary one per scope.

### Multiple products

Add `products[]` only when each product has **its own** release location (don't invent one product per marketing page that all share one changelog). Company fields (`name`, `description`, `category`, `avatar`, `social`, `tags`) are optional.

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "version": 2,
  "name": "Acme",
  "products": [
    {
      "name": "Acme Cloud",
      "releases": [
        { "url": "https://acme.com/whats-new", "feed": "https://acme.com/whats-new/rss.xml", "canonical": true },
        { "github": "acme/cloud-sdk" }
      ]
    }
  ],
  "releases": [{ "url": "https://updates.acme.com" }]
}
```

Top-level `releases` and `products` can coexist (company firehose + per-product streams).

### In a repo

Repo-root `releases.json` binds **that repo** only (`product` + `releases[]`). Use `{ "github": "self" }` when this repo's GitHub Releases are the record.

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "version": 2,
  "product": { "name": "Acme Cloud", "slug": "acme-cloud" },
  "releases": [{ "url": "https://acme.com/whats-new", "canonical": true }, { "github": "self" }]
}
```

## After you publish

1. [Submit → check your domain](/submit) and activate if you're unlisted.
2. The registry re-reads the file on a regular sweep; later edits land without re-submission.
3. **Feeds / GitHub / App Store** go live after a quick automated check. **Plain web pages** are curator-reviewed before crawl.
4. Fill-if-empty only — never overwrites curator/editorial fields. Invalid or missing file is a no-op.

No manifest yet? [Suggest a changelog URL](/submit) for curator review.

## Reference

- **`version: 2` required.** v1 is no longer read.
- **Limits:** ≤24 products, ≤8 locations per product, ≤32 locations total per file.
- **`$schema`:** optional; [published schema](https://releases.sh/schemas/releases.json) for editors.
- **Pin to registry IDs** (optional): `"registries": { "releases.sh": { "org": "org_…" } }` — IDs are on org/product pages.
- **Live example:** [releases.sh/.well-known/releases.json](https://releases.sh/.well-known/releases.json).
