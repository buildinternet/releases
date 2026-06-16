import type { Metadata } from "next";
import { MarkdownDoc } from "@/components/markdown-doc";
import { loadDoc } from "@/lib/docs";

const SLUG = "listing";

export function generateMetadata(): Metadata {
  const { frontmatter } = loadDoc(SLUG);
  return {
    title: frontmatter.title,
    description: frontmatter.description,
    openGraph: {
      title: frontmatter.title,
      description: frontmatter.description,
      url: "/docs/listing",
    },
    twitter: {
      title: frontmatter.title,
      description: frontmatter.description,
    },
    alternates: { canonical: "/docs/listing" },
  };
}

export default function ListingPage() {
  return <MarkdownDoc slug={SLUG} />;
}
