import { MarkdownDoc } from "@/components/markdown-doc";
import { TerminalCompare } from "@/components/terminal-compare";
import { loadDoc } from "@/lib/docs";

const SLUG = "examples";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

const latestDefault = `ID           Source       Title                           Version  Date
rel_a1b2c3d  claude-code  Streaming tool use              1.0.16   2026-04-14
                          Added streaming support for tool
                          use results in extended thinking…
rel_e4f5a6b  nextjs       Next.js 15.3                    15.3.0   2026-04-11
                          Turbopack is now the default bun…`;

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
    "id": "rel_e4f5a6b",
    "sourceSlug": "nextjs",
    "title": "Next.js 15.3",
    "version": "15.3.0",
    "contentSummary": "Turbopack is now the default bundler for dev and production builds.",
    "media": [
      { "type": "image", "url": "https://nextjs.org/blog/15-3/cover.png" }
    ],
    "publishedAt": "2026-04-11"
  }
]`;

const searchDefault = `Orgs
  Anthropic          anthropic    ai
  Vercel             vercel       developer-tools

Sources
  Claude Code        claude-code  github
  Claude Desktop     claude-desktop scrape

Releases
  Streaming tool use claude-code  2026-04-14
    Added streaming support for tool use results…
  Extended thinking  claude-code  2026-04-01
    New extended thinking mode with budget control…`;

const searchJson = `{
  "orgs": [
    { "slug": "anthropic", "name": "Anthropic" },
    { "slug": "vercel", "name": "Vercel" }
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

const pipeJq = `$ releases latest claude-code --count 1 --json | jq '.[0].version'
"1.0.16"`;

const pipeCurl = `$ curl -s https://api.releases.sh/v1/sources/claude-code?pageSize=1 \\
    | jq '.releases[0].title'
"Streaming tool use"`;

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
                command: "releases latest --count 2",
                output: latestDefault,
              },
              {
                label: "--json",
                command: "releases latest --count 2 --json",
                output: latestJson,
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
              },
              {
                label: "--json",
                command: 'releases search "anthropic" --json',
                output: searchJson,
              },
            ]}
          />
        ),
        "pipe-compare": (
          <TerminalCompare
            panes={[
              {
                label: "CLI + jq",
                command: "",
                output: pipeJq,
              },
              {
                label: "REST API",
                command: "",
                output: pipeCurl,
              },
            ]}
          />
        ),
      }}
    />
  );
}
