/** Explicitly selected source histories; shared by the card, search metadata, and sitemap. */
const SOURCE_DATASET_PILOTS: Partial<Record<string, string>> = {
  "anthropic/claude-code-releases": "A structured history of Claude Code",
  "openai/openai-codex-changelog": "A structured history of OpenAI Codex",
  "vercel/next-js": "A structured history of Next.js",
  "openai/openai-api-changelog": "A structured history of the OpenAI API",
  "openai/chatgpt-release-notes": "A structured history of ChatGPT",
  "openai/model-release-notes": "A structured history of OpenAI models",
  "xai/release-notes": "A structured history of the Grok API",
  "xai/release-notes-2": "A structured history of Grok",
  "xai/grok-build-releases": "A structured history of Grok Build",
  "cloudflare/cloudflare-application-performance":
    "A structured history of Cloudflare Application Performance",
  "cloudflare/cloudflare-application-security":
    "A structured history of Cloudflare Application Security",
  "cloudflare/cloudflare-cloudflare-one": "A structured history of Cloudflare One",
  "cloudflare/cloudflare-core-platform": "A structured history of Cloudflare Core Platform",
  "cloudflare/cloudflare-developer-platform":
    "A structured history of Cloudflare Developer Platform",
  "vercel/vercel": "A structured history of Vercel",
};

export function getSourceDatasetPilot(orgSlug: string, sourceSlug: string) {
  const name = SOURCE_DATASET_PILOTS[`${orgSlug}/${sourceSlug}`];
  return name
    ? {
        name,
        description:
          "Release notes organized into searchable records with dates, versions where available, and links to the original updates.",
      }
    : undefined;
}

/** Hidden and on-demand sources never join the public dataset pilot. */
export function sourceDatasetEligible(source: { isHidden?: boolean; discovery?: string | null }) {
  return source.isHidden !== true && source.discovery !== "on_demand";
}
