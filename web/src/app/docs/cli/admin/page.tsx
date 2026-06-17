import { notFound } from "next/navigation";
import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";
import { adminDocs } from "@/flags";

const SLUG = "cli/admin";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function AdminPage() {
  if (!adminDocs) notFound();
  return <MarkdownDoc slug={SLUG} />;
}
