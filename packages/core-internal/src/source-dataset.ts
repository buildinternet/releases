import {
  SourceDatasetSettingsSchema,
  type SourceDatasetSettings,
  type DatasetDescription,
} from "@buildinternet/releases-api-types/datasets";

export const DATASET_ORG_INDEX_MIN_RELEASES = 10;
export const DEFAULT_DATASET_DESCRIPTION =
  "Release notes organized into searchable records with dates, versions where available, and links to the original updates.";

/** Public source IDs retain pilot defaults when a source is renamed. */
export const DEFAULT_SOURCE_DATASETS = [
  {
    id: "src_uDHhSwgE7ufu05-FTCFtr",
    orgSlug: "anthropic",
    slug: "claude-code-releases",
    name: "A structured history of Claude Code",
  },
  {
    id: "src_5o4Llv42g_j-oLZvOjA9p",
    orgSlug: "openai",
    slug: "openai-codex-changelog",
    name: "A structured history of OpenAI Codex",
  },
  {
    id: "src_U4D8mfwIxWDEaM4qDm3Lq",
    orgSlug: "vercel",
    slug: "next-js",
    name: "A structured history of Next.js",
  },
  {
    id: "src_lUUecdtTa2GdtjHTQGpjm",
    orgSlug: "openai",
    slug: "openai-api-changelog",
    name: "A structured history of the OpenAI API",
  },
  {
    id: "src_GOemdYESxsfNSMVhbjwjy",
    orgSlug: "openai",
    slug: "chatgpt-release-notes",
    name: "A structured history of ChatGPT",
  },
  {
    id: "src_QGy15gNoAqQL9AfZlw8DM",
    orgSlug: "openai",
    slug: "model-release-notes",
    name: "A structured history of OpenAI models",
  },
  {
    id: "src_azjAV1IHH6umgA3k0uTC0",
    orgSlug: "xai",
    slug: "release-notes",
    name: "A structured history of the Grok API",
  },
  {
    id: "src_NbN7EhtP_v8wwGQuA-WIo",
    orgSlug: "xai",
    slug: "release-notes-2",
    name: "A structured history of Grok",
  },
  {
    id: "src_PQ-nwnFof5-Zg7DsDYKMS",
    orgSlug: "xai",
    slug: "grok-build-releases",
    name: "A structured history of Grok Build",
  },
  {
    id: "src_qKL2i-lRM1l_QNMpdS1vU",
    orgSlug: "cloudflare",
    slug: "cloudflare-application-performance",
    name: "A structured history of Cloudflare Application Performance",
  },
  {
    id: "src_qqhTsbg70x4e1IMbX1Dbx",
    orgSlug: "cloudflare",
    slug: "cloudflare-application-security",
    name: "A structured history of Cloudflare Application Security",
  },
  {
    id: "src_HK2nmgE5Y4mYG_7XbNmud",
    orgSlug: "cloudflare",
    slug: "cloudflare-cloudflare-one",
    name: "A structured history of Cloudflare One",
  },
  {
    id: "src_ZdOQWQjgnyQ5618DKGHXN",
    orgSlug: "cloudflare",
    slug: "cloudflare-core-platform",
    name: "A structured history of Cloudflare Core Platform",
  },
  {
    id: "src_Q3HlRau9xWBnzIb8lD9g3",
    orgSlug: "cloudflare",
    slug: "cloudflare-developer-platform",
    name: "A structured history of Cloudflare Developer Platform",
  },
  {
    id: "src_ybwLQLQFrJY-rVJQeGetN",
    orgSlug: "vercel",
    slug: "vercel",
    name: "A structured history of Vercel",
  },
] as const;

export interface DatasetSourceRef {
  id?: string;
  orgSlug?: string | null;
  slug: string;
  name?: string;
  metadata?: string | null;
  isHidden?: boolean;
  discovery?: string | null;
}

export function getDefaultSourceDataset(source: DatasetSourceRef): DatasetDescription | undefined {
  const preset = DEFAULT_SOURCE_DATASETS.find((p) =>
    source.id ? p.id === source.id : p.orgSlug === source.orgSlug && p.slug === source.slug,
  );
  return preset ? { name: preset.name, description: DEFAULT_DATASET_DESCRIPTION } : undefined;
}

/** Absent/null inherits defaults; malformed settings fail closed. */
export function readSourceDatasetSettings(metadata?: string | null): {
  valid: boolean;
  value: SourceDatasetSettings | null;
} {
  try {
    const parsed: unknown = JSON.parse(metadata ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { valid: false, value: null };
    const raw = (parsed as Record<string, unknown>).dataset;
    if (raw == null) return { valid: true, value: null };
    const result = SourceDatasetSettingsSchema.safeParse(raw);
    return result.success ? { valid: true, value: result.data } : { valid: false, value: null };
  } catch {
    return { valid: false, value: null };
  }
}

export function sourceDatasetEligible(source: { isHidden?: boolean; discovery?: string | null }) {
  return source.isHidden !== true && source.discovery !== "on_demand";
}

export function resolveSourceDataset(source: DatasetSourceRef): DatasetDescription | undefined {
  if (!sourceDatasetEligible(source)) return undefined;
  const stored = readSourceDatasetSettings(source.metadata);
  if (!stored.valid) return undefined;
  const preset = getDefaultSourceDataset(source);
  if (!(stored.value?.enabled ?? !!preset)) return undefined;
  return {
    name:
      stored.value?.name ??
      preset?.name ??
      `A structured history of ${source.name ?? source.slug}`.slice(0, 200),
    description: stored.value?.description ?? preset?.description ?? DEFAULT_DATASET_DESCRIPTION,
  };
}
