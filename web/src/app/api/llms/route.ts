import { adminDocs } from "@/flags";
import { getStaticBaseUrl } from "@/lib/base-url";
import {
  docsManifest,
  groupBySection,
  SITE_NAME,
  SITE_TAGLINE,
  type DocEntry,
} from "@/lib/docs-manifest";

const BASE_URL = getStaticBaseUrl();

const PREAMBLE = `Links below point to Markdown versions of each page. Any page on this site is also available as Markdown by appending \`.md\` to its URL (for example, ${BASE_URL}/docs/installation.md) or by sending \`Accept: text/markdown\` to the canonical URL. Use \`llms-full.txt\` for all docs concatenated into one file, intended for single-context ingestion.`;

function line(entry: DocEntry): string {
  const url = `${BASE_URL}${entry.mdPath}`;
  return entry.description
    ? `- [${entry.label}](${url}): ${entry.description}`
    : `- [${entry.label}](${url})`;
}

export function GET() {
  const grouped = groupBySection(docsManifest({ includeAdmin: adminDocs }));
  const sections = grouped
    .map(({ section, items }) => `## ${section}\n\n${items.map(line).join("\n")}`)
    .join("\n\n");

  const body = `# ${SITE_NAME}

> ${SITE_TAGLINE}

${PREAMBLE}

${sections}
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
}
