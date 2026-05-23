---
title: "Examples"
description: "Common CLI workflows for browsing, searching, and tracking releases."
adminOnly: false
---

# Examples

Every command outputs a human-readable table by default. Add `--json` for structured output that's easy for scripts and agents to parse. The release readers (`search`, `tail`/`latest`, `get`) return a [slim JSON shape](/docs/cli/browsing#slim-release-json) by default to keep token usage low — add `--full` when you need the complete payload.

## Stay up to date

See what shipped recently for a source, product, or organization.

<!-- slot:latest-compare -->

## Find what you need

Hybrid search across organizations, sources, and releases — fuses full-text and semantic (vector) matching, so you can search by meaning as well as keyword. Each result includes a content preview so you can find the right release without opening it.

<!-- slot:search-compare -->
