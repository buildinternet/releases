import { adminDocs } from "@/flags";
import { getStaticBaseUrl } from "@/lib/base-url";
import { mdxToMarkdown } from "@/lib/docs";
import { docsManifest, SITE_NAME, SITE_TAGLINE, type DocEntry } from "@/lib/docs-manifest";

const BASE_URL = getStaticBaseUrl();

function renderDoc(entry: DocEntry, showAdmin: boolean): string {
  const transformed = mdxToMarkdown(entry.doc.body, { includeAdmin: showAdmin });

  const header = `<!-- source: ${BASE_URL}${entry.path} -->`;
  return `${header}\n\n${transformed}`.trimEnd();
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
