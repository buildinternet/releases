---
title: "Installation"
adminOnly: false
---

# Installation

Get the Releases CLI up and running.

<!-- slot:install-tabs -->

## Homebrew

On macOS and Linux with [Homebrew](https://brew.sh):

```bash
brew install buildinternet/tap/releases
```

## npm

Install globally via npm — prebuilt binaries for macOS and Linux are included:

```bash
npm install -g @buildinternet/releases
```

Or run without installing:

```bash
npx @buildinternet/releases search "react"
```

## Shell script

Download and install the latest binary directly:

```bash
curl -fsSL https://releases.sh/install | bash
```

The script detects your platform, downloads the correct binary from npm, and installs it to `/usr/local/bin`. Set `RELEASED_INSTALL_DIR` to change the install location.

## From source (development)

Requires [Bun](https://bun.sh) v1.1+.

```bash
git clone https://github.com/buildinternet/released.git
cd released
bun install
bun src/index.ts --help
```

## Verify

After installing, verify the CLI is working:

```bash
releases --help
```

## MCP server

To use Releases as an MCP tool server, the easiest path is the hosted remote server at `https://mcp.releases.sh/mcp`.

<!-- slot:mcp-install-buttons -->

Codex:

```bash
codex mcp add releases --url https://mcp.releases.sh/mcp
```

Claude Code:

```bash
claude mcp add --transport http releases https://mcp.releases.sh/mcp
```

<!-- admin:start -->

Or run a local stdio server with the full tool set, including admin tools:

```bash
releases admin mcp serve
```

<!-- admin:end -->

See the [MCP Server](/docs/api/mcp) docs for the general endpoint, client-specific setup, and stdio fallback configuration.

## Telemetry

The CLI and local MCP server record anonymous usage events (command name, CLI version, OS/arch, exit code, duration) to help us understand what's used. No arguments, flag values, queries, or content are ever sent. Opt out any time:

```bash
releases telemetry disable              # persistent
RELEASED_TELEMETRY_DISABLED=1 releases … # per-invocation
```

See [Privacy & Telemetry](/docs/privacy) for the full list of what is and isn't collected.
