---
"@buildinternet/releases": patch
---

RSS feed parser now prefers `<content:encoded>` over `<description>` when both are present. Feeds like the OpenAI Codex changelog put the title in `description` and the actual markdown body in `content:encoded`; the parser was storing the stub so release pages and search results showed only the heading. Existing sources need `releases admin source fetch <slug> --force` followed by `releases admin embed releases` to pick up the richer content.
