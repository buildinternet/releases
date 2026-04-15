import { notFound } from "next/navigation";
import { MarkdownDoc } from "@/components/markdown-doc";
import { loadDoc } from "@/lib/docs";
import { adminDocs } from "@/flags";

const SLUG = "cli/analysis";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

export default async function AnalysisPage() {
  const showAdmin = await adminDocs();
  if (!showAdmin) notFound();
  return <MarkdownDoc slug={SLUG} />;
}
