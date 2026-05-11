---
title: "Why Releases"
description: "Releases is changelog infrastructure built for agents — the Context7-equivalent for what shipped. One registry across GitHub releases, CHANGELOG files, marketing blogs, RSS, and more."
adminOnly: false
---

# Why Releases

Releases is changelog infrastructure built for agents. Drop the MCP server into Claude, ChatGPT, Cursor, or your own agent and "what changed in X since Y" becomes as cheap a tool call as fetching docs — it's the [Context7](https://context7.com)-equivalent for what shipped.

That matters because changelogs have no standard. Teams publish in GitHub releases, CHANGELOG files, marketing blogs, in-app "what's new" panels, vendor newsletters — and the interesting parts rarely live where you'd guess. Releases unifies them behind one registry, so you can easily see the full story.

## Motivation

- **One feed across sources.** GitHub releases, GitHub CHANGELOG files, marketing blogs, public-facing release-notes pages, RSS/Atom, and JSON feeds all normalize into the same shape — org, product, title, date, summary, categories, tags. The launch post that never made it into a tag is in there too.
- **Product-level signal, not commit noise.** Releases are scoped to orgs and products and summarized for humans, so a roadmap review or competitive scan doesn't drown in dependency-bumps and CI tweaks — and picks up the marketing-side announcements that GitHub never sees in the first place.
- **With AI, products now change daily.** Markets move faster than any human reader can keep up with. Releases gives your agents a live view of what's shipping across the tools you depend on and the competitors you're tracking, so research prompts and weekly reviews stay current without manual hunting.

## Get started

- [Install the CLI](/docs/installation)
- [Add the skills](/docs/skills) to your agent
- [Browse the examples](/docs/examples)
