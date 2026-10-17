---
title: "Pricing"
description: "Release Notes Index is free and open source. Public reads need no account; a free account raises your API rate limit."
---

# Pricing

Release Notes Index is free. There are no paid plans, no usage fees, and no credit card to enter. The website, the REST API, the hosted MCP server, and the CLI all cost nothing to use.

## Open source

The code is public at [github.com/buildinternet/releases](https://github.com/buildinternet/releases). The CLI and the published npm packages are MIT-licensed; the rest of the repository is Apache 2.0. You can read it, fork it, or run your own copy.

## Do I need an account?

Not for reading. Search, release lookups, org and source pages, feeds, the REST API, and the MCP server's read tools all work anonymously — no sign-up and no API key.

A free account adds two things:

- **Higher API rate limits.** Anonymous requests are limited per IP. Requests made with a free API key are counted against your account instead, with a higher ceiling.
- **Personal features.** Follows, a personalized feed, webhooks, and email alerts are tied to an account.

To get a key, run `releases login` or create one under **Account → API Keys** on the website. Send it as `Authorization: Bearer <key>`. User API keys are read-only.

## Rate limits

The API applies rate limits to keep the service fair for everyone. When you hit a limit you get a `429` with a `Retry-After` header — back off and retry. If a legitimate integration needs more, email [hi@releases.sh](mailto:hi@releases.sh).

## For publishers

Getting your product listed is also free. See [Add your product](/docs/listing).

## Related

- [Terms of Service](/terms) — acceptable use and rate limits.
- [Agent authentication](/auth.md) — OAuth discovery and token how-to.
- [REST API](/docs/api/rest) and [MCP server](/docs/api/mcp) docs.
