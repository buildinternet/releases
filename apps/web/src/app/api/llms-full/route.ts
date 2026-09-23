import matter from "gray-matter";
import { adminDocs } from "@/flags";
import { getStaticBaseUrl } from "@/lib/base-url";
import { stripAdminBlocks, keepAdminBlocks } from "@/lib/docs";
import {
  docsManifest,
  getLoadedDoc,
  SITE_NAME,
  SITE_TAGLINE,
  type DocEntry,
} from "@/lib/docs-manifest";

const BASE_URL = getStaticBaseUrl();

function renderDoc(entry: DocEntry, showAdmin: boolean): string {
  const parsed = matter(getLoadedDoc(entry.slug).public);
  const transformed = showAdmin
    ? keepAdminBlocks(parsed.content)
    : stripAdminBlocks(parsed.content);

  const header = `<!-- source: ${BASE_URL}${entry.path} -->`;
  return `${header}\n\n${transformed.trimStart()}`.trimEnd();
}

export function GET() {
  const showAdmin = adminDocs;
  const entries = docsManifest({ includeAdmin: showAdmin });

  const header = `# ${SITE_NAME}

> ${SITE_TAGLINE}

All public documentation pages concatenated below, in sidebar order. Each section is preceded by an HTML comment pointing at its canonical URL.
`;

  const body = entries.map((e) => renderDoc(e, showAdmin)).join("\n\n---\n\n");

  return new Response(`${header}\n${body}\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
}
