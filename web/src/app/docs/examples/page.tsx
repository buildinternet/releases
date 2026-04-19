import { countTokens } from "@releases/core-internal/tokens";
import { MarkdownDoc } from "@/components/markdown-doc";
import { TerminalCompare } from "@/components/terminal-compare";
import { loadDoc } from "@/lib/docs";

const SLUG = "examples";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

function paneTokens(command: string, output: string): number {
  return countTokens(command ? `$ ${command}\n${output}` : output);
}

const latestDefault = `ID           Source       Title                           Version  Date
rel_a1b2c3d  claude-code  Streaming tool use              1.0.16   2026-04-14
                          Added streaming support for tool
                          use results in extended thinking…
rel_f2e3d4c  claude-code  Extended thinking               1.0.15   2026-04-01
                          New extended thinking mode with
                          budget control for Claude models…`;

const latestJson = `[
  {
    "id": "rel_a1b2c3d",
    "sourceSlug": "claude-code",
    "title": "Streaming tool use",
    "version": "1.0.16",
    "contentSummary": "Added streaming support for tool use results in extended thinking mode.",
    "media": [],
    "publishedAt": "2026-04-14"
  },
  {
    "id": "rel_f2e3d4c",
    "sourceSlug": "claude-code",
    "title": "Extended thinking",
    "version": "1.0.15",
    "contentSummary": "New extended thinking mode with budget control for Claude models.",
    "media": [],
    "publishedAt": "2026-04-01"
  }
]`;

const searchDefault = `Orgs
  Anthropic          anthropic    ai

Sources
  Claude Code        claude-code     github
  Claude Desktop     claude-desktop  scrape

Releases
  Streaming tool use claude-code  2026-04-14
    Added streaming support for tool use results…
  Extended thinking  claude-code  2026-04-01
    New extended thinking mode with budget control…`;

const searchJson = `{
  "orgs": [
    { "slug": "anthropic", "name": "Anthropic" }
  ],
  "sources": [
    { "slug": "claude-code", "type": "github" },
    { "slug": "claude-desktop", "type": "scrape" }
  ],
  "releases": [
    {
      "id": "rel_a1b2c3d",
      "title": "Streaming tool use",
      "summary": "Added streaming support for tool use results in extended thinking mode.",
      "publishedAt": "2026-04-14"
    },
    {
      "id": "rel_f2e3d4c",
      "title": "Extended thinking",
      "summary": "New extended thinking mode with budget control for Claude models.",
      "publishedAt": "2026-04-01"
    }
  ]
}`;

export default function ExamplesPage() {
  return (
    <MarkdownDoc
      slug={SLUG}
      slots={{
        "latest-compare": (
          <TerminalCompare
            panes={[
              {
                label: "default",
                command: "releases tail claude-code --count 2",
                output: latestDefault,
                tokens: paneTokens("releases tail claude-code --count 2", latestDefault),
              },
              {
                label: "JSON",
                command: "releases tail claude-code --count 2 --json",
                output: latestJson,
                tokens: paneTokens("releases tail claude-code --count 2 --json", latestJson),
              },
            ]}
          />
        ),
        "search-compare": (
          <TerminalCompare
            panes={[
              {
                label: "default",
                command: 'releases search "anthropic"',
                output: searchDefault,
                tokens: paneTokens('releases search "anthropic"', searchDefault),
              },
              {
                label: "JSON",
                command: 'releases search "anthropic" --json',
                output: searchJson,
                tokens: paneTokens('releases search "anthropic" --json', searchJson),
              },
            ]}
          />
        ),
      }}
    />
  );
}
