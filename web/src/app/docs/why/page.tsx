import type { Metadata } from "next";
import { MarkdownDoc } from "@/components/markdown-doc";
import { loadDoc } from "@/lib/docs";

const SLUG = "why";

export function generateMetadata(): Metadata {
  const { frontmatter } = loadDoc(SLUG);
  return {
    title: frontmatter.title,
    description: frontmatter.description,
    openGraph: {
      title: frontmatter.title,
      description: frontmatter.description,
      url: "/docs/why",
    },
    twitter: {
      title: frontmatter.title,
      description: frontmatter.description,
    },
    alternates: { canonical: "/docs/why" },
  };
}

export default function WhyPage() {
  return <MarkdownDoc slug={SLUG} />;
}
