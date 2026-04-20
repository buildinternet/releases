import type { Metadata } from "next";
import { StaticMarkdownPage, staticPageMetadata } from "@/components/markdown-page";

export function generateMetadata(): Metadata {
  return staticPageMetadata("privacy");
}

export default function PrivacyPage() {
  return <StaticMarkdownPage slug="privacy" />;
}
