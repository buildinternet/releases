import { MarkdownDoc } from "@/components/markdown-doc";
import { TerminalCompare } from "@/components/terminal-compare";
import { loadDoc } from "@/lib/docs";

const SLUG = "examples";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

const latestDefault = `ID           Source       Title               Version  Date
rel_a1b2c3d  claude-code  Streaming tool use  1.0.16   2026-04-14
rel_e4f5a6b  nextjs       Next.js 15.3        15.3.0   2026-04-11`;

const latestJson = `[
  {
    "id": "rel_a1b2c3d",
    "sourceSlug": "claude-code",
    "title": "Streaming tool use",
    "version": "1.0.16",
    "publishedAt": "2026-04-14"
  },
  {
    "id": "rel_e4f5a6b",
    "sourceSlug": "nextjs",
    "title": "Next.js 15.3",
    "version": "15.3.0",
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
  Extended thinking  claude-code  2026-04-01`;

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
      "publishedAt": "2026-04-14"
    },
    {
      "id": "rel_f2e3d4c",
      "title": "Extended thinking",
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
      }}
    />
  );
}
