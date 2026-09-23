import type { Metadata } from "next";
import { StaticMarkdownPage, staticPageMetadata } from "@/components/markdown-page";

export function generateMetadata(): Metadata {
  return staticPageMetadata("security");
}

export default function SecurityPage() {
  return <StaticMarkdownPage slug="security" />;
}
