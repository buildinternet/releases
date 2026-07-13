import type { Metadata } from "next";
import type { ReactNode } from "react";
import { MarkdownDoc } from "@/components/markdown-doc";
import { loadPage } from "@/lib/docs";

export function staticPageMetadata(slug: string): Metadata {
  const { frontmatter } = loadPage(slug);
  const { title, description } = frontmatter;
  // A static page lives at its own top-level path (`/privacy`, `/terms`, …).
  // Emit a complete openGraph block — a page that sets `openGraph` replaces the
  // root layout's wholesale, so `type`/`url` must be set here, and the canonical
  // keeps og:url honest (Ahrefs flagged both missing across these pages, June 2026).
  const url = `/${slug}`;
  return {
    title,
    description,
    openGraph: {
      type: "website",
      url,
      title,
      ...(description ? { description } : {}),
    },
    twitter: {
      title,
      ...(description ? { description } : {}),
    },
    alternates: { canonical: url },
  };
}

export function StaticMarkdownPage({
  slug,
  slots,
}: {
  slug: string;
  slots?: Record<string, ReactNode>;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <article className="pixel-doc-title max-w-3xl w-full mx-auto px-6 py-10 flex-1 prose prose-stone dark:prose-invert prose-headings:tracking-tight prose-code:before:content-none prose-code:after:content-none prose-code:bg-stone-100 prose-code:dark:bg-stone-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono">
        <MarkdownDoc slug={slug} slots={slots} loader={loadPage} />
      </article>
    </div>
  );
}
