import { notFound } from "next/navigation";
import { adminDocs } from "@/flags";
import { CopyPageButton } from "@/components/copy-page-button";
import { docsMdxComponents } from "@/components/docs/mdx-components";
import { docMarkdown } from "@/lib/docs";
import { findVisibleDoc } from "@/lib/docs-manifest";
import { source } from "@/lib/source";

/** The listed, visible doc for URL segments (`index` for `/docs`), if any. */
export function resolveDoc(parts: string[] | undefined) {
  return findVisibleDoc(parts?.length ? parts.join("/") : "index", { includeAdmin: adminDocs });
}

/** A docs page's Copy page bar and compiled MDX body. Shared by both docs areas. */
export function DocPageBody({ parts }: { parts: string[] }) {
  const doc = resolveDoc(parts);
  const page = doc && source.getPage(parts);
  if (!doc || !page) notFound();

  const Body = page.data.body;
  return (
    <>
      <div className="not-prose mb-8 flex justify-end">
        <CopyPageButton markdown={docMarkdown(doc, { includeAdmin: adminDocs })} slug={doc.slug} />
      </div>
      <Body components={docsMdxComponents} />
    </>
  );
}
