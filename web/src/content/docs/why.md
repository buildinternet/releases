---
title: "Why Releases"
description: "Releases is changelog infrastructure built for agents — the Context7-equivalent for what shipped. One registry across GitHub releases, CHANGELOG files, marketing blogs, RSS, and more."
adminOnly: false
---

# Why Releases

Releases is a changelog index built for agents. Add the MCP server to Claude, ChatGPT, Cursor, or your own agent, and "what changed in X since Y" becomes one cheap tool call, as easy as fetching docs. Think of it as the [Context7](https://context7.com) of what shipped.

This matters because changelogs have no standard. Teams publish in GitHub releases, CHANGELOG files, marketing blogs, in-app "what's new" panels, and vendor newsletters. The interesting parts rarely live where you'd guess. Releases pulls them into one registry so you can see the full story.

## Motivation

- **One feed across sources.** GitHub releases, CHANGELOG files, marketing blogs, release-notes pages, RSS/Atom, and JSON feeds all come out in the same shape: org, product, title, date, summary, categories, tags. The launch post that never got a version tag is in there too.
- **Product-level signal, not commit noise.** Releases are grouped by org and product and summarized for humans. A weekly review doesn't drown in dependency bumps and CI tweaks, and it picks up the announcements that GitHub never sees at all.
- **With AI, products now change daily.** No human can read it all anymore. Releases gives your agents a live view of what's shipping across the tools you depend on, so research prompts and weekly reviews stay current without manual hunting.
- **Input agents can act on, not just report.** As agents get more autonomous, knowing what the rest of the industry is building becomes real input: an agent can look at what's shipping across its field, spot what's emerging, and use that to decide what's worth building next.

## Get started

- [Install the CLI](/docs/installation)
- [Add the skills](/docs/skills) to your agent
- [Browse the examples](/docs/examples)
