import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiNotFoundError, ApiSetupError } from "@/lib/api";
import { SetupMessage } from "@/components/setup-message";
import { BreadcrumbHome } from "@/components/breadcrumb-home";
import { DigestBetaNote } from "@/components/digest-beta-note";
import { DigestFormatLinks } from "@/components/digest-format-links";
import { weekOfLabel } from "@/lib/digest-format";
import { getDigestIndex } from "./_lib/digest-data";

export const revalidate = 900;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const { detail } = await getDigestIndex(slug);
    const path = `/collections/${slug}/digest`;
    return {
      title: `${detail.name} weekly digests`,
      description: `Past weekly digests summarizing what shipped across ${detail.name}.`,
      alternates: {
        canonical: path,
        // Atom only — same as org/collection pages. md/json are export chips.
        types: {
          "application/atom+xml": [{ url: `${path}.atom`, title: `${detail.name} weekly digests` }],
        },
      },
      openGraph: { type: "website", url: path },
    };
  } catch {
    return { title: "Weekly digests" };
  }
}

export default async function CollectionDigestIndexPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  let page;
  try {
    page = await getDigestIndex(slug);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  const { detail, digests } = page;

  return (
    <div className="org-surface min-h-screen bg-[var(--page)] text-[var(--fg)]">
      <div className="mx-auto max-w-[760px] px-6 pb-24 pt-5">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-[13px] text-[var(--fg-3)]"
        >
          <BreadcrumbHome />
          <span className="text-[var(--line-2)]" aria-hidden>
            /
          </span>
          <Link href="/collections" className="transition-colors hover:text-[var(--fg-2)]">
            Collections
          </Link>
          <span className="text-[var(--line-2)]" aria-hidden>
            /
          </span>
          <Link
            href={`/collections/${slug}`}
            className="transition-colors hover:text-[var(--fg-2)]"
          >
            {detail.name}
          </Link>
        </nav>

        <DigestBetaNote className="mt-4" />

        <h1 className="mt-4 text-balance text-[28px] font-bold tracking-tight text-[var(--fg)]">
          {detail.name} weekly digests
        </h1>
        <DigestFormatLinks path={`/collections/${slug}/digest`} className="mt-3" />

        {digests.length === 0 ? (
          <p className="mt-6 text-[14px] text-[var(--fg-3)]">
            No digests yet — check back after the next weekly roundup.
          </p>
        ) : (
          <ul className="mt-8 flex flex-col gap-6">
            {digests.map((d) => (
              <li key={d.id} className="border-b border-[var(--line-2)] pb-6 last:border-none">
                <div className="text-[12px] font-medium text-[var(--fg-3)]">
                  {weekOfLabel(d.weekStart)}
                </div>
                <Link
                  href={`/collections/${slug}/digest/${d.weekStart}`}
                  className="mt-1 block text-[17px] font-semibold text-[var(--fg)] transition-colors hover:text-[var(--accent)]"
                >
                  {d.title}
                </Link>
                <p className="mt-1 max-w-[65ch] text-[14px] text-[var(--fg-2)]">{d.intro}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
