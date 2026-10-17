import type { Metadata } from "next";
import { StaticMarkdownPage, staticPageMetadata } from "@/components/markdown-page";

export function generateMetadata(): Metadata {
  return staticPageMetadata("pricing");
}

export default function PricingPage() {
  return <StaticMarkdownPage slug="pricing" />;
}
