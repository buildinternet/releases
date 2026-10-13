"use client";

import { releasePath, type ReleaseSlugInput } from "@buildinternet/releases-core/release-slug";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { CopyIcon } from "./copy-icon";

/**
 * Copies a release's permalink (`/release/rel_…`) to the clipboard. The
 * permalink is a stable way to reference one release (share it, hand it to an
 * agent); it is a button rather than a link so feed pages don't send readers
 * or crawlers to the on-site copy of the release text.
 */
export function CopyReleaseLink({ release }: { release: { id: string } & ReleaseSlugInput }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => copy(`${window.location.origin}${releasePath(release)}`)}
      className="inline-flex items-center gap-1 text-[12px] text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 cursor-pointer"
    >
      <CopyIcon copied={copied} size={12} />
      <span aria-live="polite">{copied ? "Copied" : "Copy link"}</span>
    </button>
  );
}
