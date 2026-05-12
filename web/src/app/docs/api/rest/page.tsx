import type { Metadata } from "next";
import { MarkdownDoc } from "@/components/markdown-doc";
import { getLoadedDoc } from "@/lib/docs-manifest";

const SLUG = "api/rest";

export function generateMetadata(): Metadata {
  const { frontmatter } = getLoadedDoc(SLUG);
  return { title: frontmatter.title, description: frontmatter.description };
}

export default function RestApiDocsPage() {
  return <MarkdownDoc slug={SLUG} />;
}
