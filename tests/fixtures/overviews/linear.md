Linear's current focus is the full deployment loop — **Linear Releases** shipped in late April as a first-class CI/CD integration that tracks every issue from merge to production. Issues auto-advance through statuses as code lands in each environment, and Linear Agent can generate release notes across a version range directly from the included issues.

![Issue sidebar showing a progression of iOS releases](https://webassets.linear.app/images/ornj730p/production/ebc92422119e3015828e065d89dee22185e53a1a-3600x1760.png?q=95&auto=format&dpr=2)

**Linear Agent expanded its context reach via MCP** — the agent can now connect to external MCP servers (Granola, Glean, Notion, PostHog) to pull meeting notes, enterprise context, or analytics into issues and project specs. Workspace admins control access with allowlists. Separately, Linear Agent's triage automations and skills system launched in March, with Code Intelligence (codebase-aware Q&A) announced for Business and Enterprise.

**Microsoft Teams joined the integration surface** — @mention `@Linear` in any Teams channel to file bugs, query projects, or create issues from video transcripts. Custom coding tool integrations landed alongside this, letting teams configure URL- or command-based launchers for tools not yet natively supported. Deeplinking expanded to cover Amp, Devin, Factory, Warp, Windsurf, and others.

**MCP server dropped SSE in favor of HTTP streams** — update endpoints from `https://mcp.linear.app/sse` to `https://mcp.linear.app/mcp`. The server also gained initiatives, project milestones, updates, and pagination for comments; MCP OAuth connections no longer disconnect after ~1 day.

**Organizational structure deepened** — teams nest up to five levels with inherited workflows. Projects and initiatives added comment threads for high-level discussion alongside formal updates.
