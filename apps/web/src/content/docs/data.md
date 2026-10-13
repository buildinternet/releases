---
title: "Data"
description: "What Release Notes Index holds (organizations, products, sources, releases, collections, overviews, and digests) and every way to read it: web pages, Markdown, JSON, and Atom variants, the REST API, the MCP server, the CLI, webhooks, and llms.txt."
adminOnly: false
---

# Data

Release Notes Index is a public registry of software releases. Most of it can be read without an account or API key: on the website, as Markdown, JSON, or Atom versions of each page, through the REST API, the MCP server, or the CLI.

For how the data is collected and which fields are AI-generated, see [How the index is built](/docs/methodology).

## Contents of the index

- **Organizations.** Companies and teams that publish releases, with a name, domain, category, and tags.
- **Products.** An optional layer inside an organization, for companies that ship more than one product.
- **Sources.** The places an organization publishes updates: GitHub releases, RSS and Atom feeds, changelog pages, App Store listings, and YouTube channels. For GitHub sources, the repository's `CHANGELOG` files are stored as well.
- **Releases.** One entry each, with a title, version, publish date, the original text, images, and a link to the original post. Many releases also carry AI-generated fields: a title, a short title, a summary, and an importance score from 1 to 5.
- **Collections.** Curated groups of related organizations, such as a set of AI labs or frontend frameworks. Each has a combined release feed, short daily summaries, and weekly digests.
- **Categories.** A fixed list of industry groupings for organizations, each with its own release feed.
- **Organization overviews.** AI-generated briefings on what each company has shipped recently.

## Reading the data

### Web pages

Browse the [catalog](/catalog), [categories](/categories), [collections](/collections), and the [latest releases](/updates) on the site. Each organization, product, source, and release has its own page.

### Markdown, JSON, and Atom variants

Add a suffix to a page URL to get the same content in another format. No account or key is needed.

| Suffix  | Format                                  | Works on                                                                             |
| ------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| `.md`   | Markdown, for reading into an LLM       | Organization, product, source, release, collection, category, digest, and docs pages |
| `.json` | JSON                                    | Organization, product, source, release, collection, and category pages               |
| `.atom` | Atom feed, for feed readers and scripts | Organization, product, source, collection, category, and digest pages                |

For example, `https://releases.sh/anthropic.md` and `https://releases.sh/anthropic/claude-code.atom`. A page URL also returns Markdown when the request sends an `Accept: text/markdown` header. The [RSS guide](/docs/guides/changelog-rss-feed) covers the Atom feeds in more depth.

### REST API

The [REST API](/docs/api/rest) at `https://api.releases.sh/v1` serves organizations, products, sources, releases, collections, search, and more as JSON. Most read endpoints are public and need no key. Requests without a key are rate-limited per IP address. An [OpenAPI 3.1 spec](https://api.releases.sh/v1/openapi.json) describes every public endpoint.

### MCP server

MCP (Model Context Protocol) is an open standard for connecting AI agents to tools and data. The hosted [MCP server](/docs/api/mcp) lets agents such as Claude and Cursor search the index and read releases as tool calls. The read tools are public and need no key.

### CLI

The open-source `releases` [CLI](/docs/cli/browsing) lists, searches, and reads the index from a terminal. [Installation](/docs/installation) covers Homebrew, npm, and prebuilt binaries. `releases tail -f` follows new releases as they land.

### Notifications and webhooks

With a free account you can follow organizations and products and get new releases pushed to you: an email digest, a [Slack](/docs/integrations/slack) or [Discord](/docs/integrations/discord) message, or a signed [webhook](/docs/api/webhooks) to your own server. The [notifications guide](/docs/guides/release-notifications) compares the options.

### llms.txt

[`/llms.txt`](/llms.txt) is a short, machine-readable index of these docs and endpoints for AI agents. [`/llms-full.txt`](/llms-full.txt) holds every docs page in one file.

## Use and attribution

Release notes belong to the companies that published them, and the index makes no ownership claim over that content. Each release links back to its source, as described in [Attribution](/docs/methodology#attribution). Before you republish a publisher's text, check that publisher's own terms. The [terms of service](/terms) cover acceptable use, including rate limits and bulk republishing. The CLI is open source under the MIT license.
