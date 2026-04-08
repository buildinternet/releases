import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { DocsNav } from "@/components/docs-nav";
import { publicDocs } from "@/flags";

export const metadata = {
  title: "Docs",
};

export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  const docsEnabled = await publicDocs();
  if (!docsEnabled) notFound();
  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-5xl mx-auto px-6 py-10 flex gap-12">
        <DocsNav />
        <article className="min-w-0 flex-1 prose prose-stone dark:prose-invert prose-headings:tracking-tight prose-code:before:content-none prose-code:after:content-none prose-code:bg-stone-100 prose-code:dark:bg-stone-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono">
          {children}
        </article>
      </div>
    </div>
  );
}
