---
title: "Examples"
description: "Common CLI workflows for browsing, searching, and tracking releases."
adminOnly: false
---

# Examples

Every command prints a readable table by default. Add `--json` for structured output that scripts and agents can parse. The release readers (`search`, `tail`/`latest`, `get`) return a [slim JSON shape](/docs/cli/browsing#slim-release-json) by default to keep token usage low. Add `--full` when you need everything.

## Stay up to date

See what shipped recently for a source, product, or organization.

<!-- slot:latest-compare -->

## Find what you need

Search works across organizations, sources, and releases. It matches by meaning as well as by keyword (full-text plus semantic search combined). Each result includes a content preview, so you can find the right release without opening it.

<!-- slot:search-compare -->
