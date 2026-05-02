---
title: "Installation"
description: "Install the Releases CLI via Homebrew, npm, a one-line script, or precompiled binaries from GitHub Releases."
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

Install globally via npm — prebuilt binaries for macOS, Linux, and Windows (x64) are included:

```bash
npm install -g @buildinternet/releases
```

Or run without installing:

```bash
npx @buildinternet/releases search "react"
```

## Shell script (macOS, Linux)

Download and install the latest binary directly:

```bash
curl -fsSL https://releases.sh/install | bash
```

The script detects your platform, downloads the correct binary from npm, and installs it to `/usr/local/bin`. Set `RELEASED_INSTALL_DIR` to change the install location. Windows users should use npm or the GitHub Releases archive below.

## GitHub Releases (precompiled binaries)

Each version publishes precompiled binaries for every supported platform on the [`buildinternet/releases-cli` releases page](https://github.com/buildinternet/releases-cli/releases). Useful for air-gapped installs, pinning to a specific version, or platforms where npm and Homebrew aren't an option.

Available archives per release:

- `releases-darwin-arm64.gz` — macOS Apple Silicon
- `releases-darwin-x64.gz` — macOS Intel
- `releases-linux-arm64.gz` — Linux ARM64
- `releases-linux-x64.gz` — Linux x86_64
- `releases-windows-x64.zip` — Windows x86_64

Each archive ships with a matching `.sha256` file, plus a top-level `checksums.txt` covering the whole release.

**macOS / Linux:**

```bash
# Pick the archive that matches your platform
curl -fsSL -o releases.gz https://github.com/buildinternet/releases-cli/releases/latest/download/releases-darwin-arm64.gz
gunzip releases.gz
chmod +x releases
mv releases /usr/local/bin/
```

**Windows (PowerShell):**

```powershell
Invoke-WebRequest -Uri "https://github.com/buildinternet/releases-cli/releases/latest/download/releases-windows-x64.zip" -OutFile "releases.zip"
Expand-Archive -Path "releases.zip" -DestinationPath "."
# Move releases-windows-x64.exe somewhere on your PATH and rename to releases.exe
```

## From source (development)

The CLI source lives at [github.com/buildinternet/releases-cli](https://github.com/buildinternet/releases-cli). Requires [Bun](https://bun.sh) v1.1+ (Bun supports macOS, Linux, and Windows).

```bash
git clone https://github.com/buildinternet/releases-cli.git
cd releases-cli
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
