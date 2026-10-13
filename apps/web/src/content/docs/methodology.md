---
title: "How the index is built"
description: "How Release Notes Index finds sources, checks them for new releases, turns pages into release records, and which parts are AI-generated. Also how publishers can opt out, publish directly, or ask for a correction."
adminOnly: false
---

# How the index is built

Release Notes Index collects release notes from the places companies already publish them. Each entry is stored as a release with a link back to its source, plus a few AI-generated fields. The original text and its source stay on every release.

For the formats and interfaces you can use to read the data, see [Data](/docs/data).

## Adding sources

A **source** is one place a company publishes updates: a GitHub repository's releases, an RSS or Atom feed, a changelog page, an App Store listing, or a YouTube channel. Sources belong to an **organization** and can be grouped under a **product**. The [overview](/docs) explains this hierarchy.

Sources reach the index in four ways:

- **Curated onboarding.** Maintainers add most sources by hand. AI agents help them find a company's changelog, feed, or GitHub repository and pick the most direct way to read it. A feed or the GitHub API is preferred over reading a rendered page.
- **Owner listing.** A company can publish a [`releases.json`](/docs/listing) file on its domain that says where it posts updates. Checking the file on the [submit page](/submit) creates a basic listing for that domain. After the owner proves they control the domain, feed, GitHub, and App Store entries become live sources. Plain page URLs wait for a maintainer to review them.
- **Suggestions.** Anyone can suggest a release notes URL on the [submit page](/submit). A maintainer reviews it before anything is added.
- **On-demand lookups.** An authorized agent can ask for a GitHub repository the index does not have yet. The repository is added as a hidden source. It can answer that agent's question, but it does not appear in browsing and does not get AI summaries.

## Check schedule

Each source is checked on its own schedule. Sources that publish often are checked several times a day, and sources that publish rarely about once a day. A daily job looks at how often each source has published recently and moves it between those two schedules.

When a source has not changed for a while, or keeps returning errors, the wait between checks grows. When it changes again, checks speed back up. For feeds, the index first asks the server whether anything changed, and skips the full download when nothing did.

Two kinds of source are never checked:

- **Paused sources** are skipped until a maintainer turns them back on.
- **Push-fed sources** get new entries from their publishers' own build pipelines (see [Publishing directly](#publishing-directly)), so they have no schedule.

## From page to release

How a release is read depends on the source type:

- **Feeds and GitHub releases** are already structured. Each item becomes a release without an AI step.
- **Changelog pages** get a feed check first. If the page has an RSS, Atom, or JSON feed, the index uses it. If not, the page is loaded in a browser, and an AI model reads it and pulls out each entry's title, version, date, and text. Very long pages are read in pieces so the model handles only the parts it needs.
- **Feeds that carry only a short summary** get a second step. For each new item, the index fetches the linked post and uses an AI model to pull out the article text. If that fails, the feed summary is kept.

Images in a release are copied to the index's own media host, so they keep loading if the original image URL changes. Links to hosted videos (YouTube, Vimeo, Loom, Wistia) show as a preview card that links to the video.

### Duplicates

A release is identified by its source and its URL. When a source is checked again, an entry that is already stored is not added a second time. A later check can fill in missing text, but it does not overwrite text that is already there.

### One launch, several posts

Companies often announce one launch in several places: a blog post, a changelog entry, and an app update note. The index can group these so the launch shows once, with the other posts listed as coverage of it. When one change bumps versions across many packages in a monorepo, those releases are grouped automatically as they arrive. Maintainers make other groupings with help from an AI agent, and each grouping records who made it. Grouped posts are hidden from default lists but stay in the index.

### Excluded content

- **Ignored and blocked URLs.** Maintainers can ignore specific URLs for one organization, or block spam domains everywhere. Matching entries are never stored.
- **Suppressed releases.** A release can be hidden from every public list and search without being deleted. Maintainers do this by hand, and the marketing filter below does it automatically.

## AI-generated fields

AI models write the parts below. Most requests go through OpenRouter and some go to Anthropic directly. The models only see public release content. The site labels these parts, and the original release text and its source link stay next to them.

- **Titles and summaries.** A generated title, a short title, and a summary of the release. On a release page the summary sits above the original text, with a note that AI-generated summaries may contain mistakes.
- **Importance score.** A score from 1 to 5 for how significant a release is for that company. The site marks releases that score 4 or 5. When the model cannot score a release, it has no score; the index never fills in a guess.
- **Breaking-change check.** Whether a release appears to contain a breaking change. This feeds answers to "what changed between these two versions" questions.
- **Organization overviews.** A short briefing on what a company has shipped recently. Overviews are rewritten on a schedule as new releases arrive, and every surface flags an overview that has gone stale.
- **Collection summaries and weekly digests.** For [collections](/collections) of related companies, a short daily summary and a weekly digest of what shipped. Digests carry their own AI disclaimer.
- **Marketing filter.** Some company blogs mix product news with case studies, newsletters, and event recaps. For those sources only, an AI model reads each new post and hides the ones it is confident are marketing. Hidden posts are kept, not deleted, and the decision can be reversed.

Summaries, importance scores, and overviews are turned on per organization, so not every release has them. If an AI step fails, the release is stored as it came in, without the AI fields.

## Publisher controls

### Opt-out signals

When maintainers use AI agents to read a site's pages directly, a required first step reads the site's `robots.txt` file (the file sites use to tell automated visitors what they may fetch). If the file has a Content Signal of `ai-input=no`, which asks that the content not be used as input to AI, the agent stops and does not add the content. A signal of `ai-train=no` on its own does not stop it, because the index does not train AI models. When the agent cannot read the file clearly, it stops and asks a person.

The index's crawler identifies itself with its own user agent and signs its direct requests. The [crawler page](/bot) lists the details.

### Publishing directly

Publishers whose changelog lives in a Git repository can send new entries straight to the index instead of waiting for the next check. After the domain is verified, the owner creates a publish token for one source and uses the [GitHub Action](/docs/integrations/github-actions) or [`releases publish` from any CI](/docs/integrations/ci). Each push adds or updates entries right away. The [listing guide](/docs/listing) covers the `releases.json` side.

### Corrections and removal

- To report a wrong or broken release, organization, or source, use the **Report** link on that page. The report goes to the maintainers along with the page it came from.
- To have a source removed, or to report content you believe infringes your rights, email [abuse@releases.sh](mailto:abuse@releases.sh) with the source or page URL and your relationship to the content. The [privacy policy](/privacy#takedowns-and-content-removal) describes the process.
- For anything else, email [hi@releases.sh](mailto:hi@releases.sh).

## Attribution

Every source page links to the publisher's own page. Every release that has its own URL has a "View original" link to the original post, and the release page's structured data marks it as based on that post. Copyright in release notes stays with the publishers; see the [terms](/terms#content-and-attribution).
