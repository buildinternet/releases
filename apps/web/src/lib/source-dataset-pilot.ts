/** A small editorial pilot, shared by the visible description and search metadata. */
const SOURCE_DATASET_PILOTS: Partial<Record<string, { name: string; description: string }>> = {
  "anthropic/claude-code-releases": {
    name: "A structured history of Claude Code",
    description:
      "Release notes organized into searchable records with dates, versions where available, and links to the original updates.",
  },
  "openai/openai-codex-changelog": {
    name: "A structured history of OpenAI Codex",
    description:
      "Release notes organized into searchable records with dates, versions where available, and links to the original updates.",
  },
  "vercel/next-js": {
    name: "A structured history of Next.js",
    description:
      "Release notes organized into searchable records with dates, versions where available, and links to the original updates.",
  },
};

export function getSourceDatasetPilot(orgSlug: string, sourceSlug: string) {
  return SOURCE_DATASET_PILOTS[`${orgSlug}/${sourceSlug}`];
}

/** Hidden and on-demand sources never join the public dataset pilot. */
export function sourceDatasetEligible(source: { isHidden?: boolean; discovery?: string | null }) {
  return source.isHidden !== true && source.discovery !== "on_demand";
}
