import type { Metadata } from "next";
import { adminDocs } from "@/flags";
import { DocPageBody, resolveDoc } from "@/components/docs/doc-page-body";
import { docPageMetadata } from "@/lib/doc-metadata";
import { API_REFERENCE_SLUG, apiReferenceEntries, docsManifest } from "@/lib/docs-manifest";

/** Pages of the API reference area: the landing page and every endpoint page. */
type Props = { params: Promise<{ slug?: string[] }> };

const BASE = API_REFERENCE_SLUG.split("/");

export function generateStaticParams() {
  return apiReferenceEntries(docsManifest({ includeAdmin: adminDocs })).map((entry) => ({
    slug: entry.slug.split("/").slice(BASE.length),
  }));
}

function parts(slug: string[] | undefined): string[] {
  return [...BASE, ...(slug ?? [])];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = resolveDoc(parts((await params).slug));
  return doc ? docPageMetadata(doc.slug, doc.frontmatter) : {};
}

export default async function ApiReferencePage({ params }: Props) {
  return <DocPageBody parts={parts((await params).slug)} />;
}
