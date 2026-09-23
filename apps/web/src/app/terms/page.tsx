import type { Metadata } from "next";
import { StaticMarkdownPage, staticPageMetadata } from "@/components/markdown-page";

export function generateMetadata(): Metadata {
  return staticPageMetadata("terms");
}

export default function TermsPage() {
  return <StaticMarkdownPage slug="terms" />;
}
