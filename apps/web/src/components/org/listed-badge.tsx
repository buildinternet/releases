"use client";

import { useState } from "react";
import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import {
  listedBadgeImageUrl,
  listedBadgeSnippets,
  type ListedBadgeTheme,
} from "@/lib/listed-badge";

type Format = "markdown" | "html";

const THEMES: { id: ListedBadgeTheme; label: string; swatch: string }[] = [
  { id: "light", label: "Light", swatch: "bg-white" },
  { id: "dark", label: "Dark", swatch: "bg-stone-900" },
];

const FORMATS: { id: Format; label: string }[] = [
  { id: "markdown", label: "Markdown" },
  { id: "html", label: "HTML" },
];

/**
 * Release Notes Index badge picker for a verified owner: choose the
 * light or dark badge, then copy a Markdown (README) or HTML (website) snippet
 * that links to the org's canonical page (`orgUrl`, the claim's `org.webUrl`).
 */
export function ListedBadge({ orgUrl }: { orgUrl: string }) {
  const [theme, setTheme] = useState<ListedBadgeTheme>("light");
  const [format, setFormat] = useState<Format>("markdown");
  const { copied, copy } = useCopyToClipboard();

  const snippet = listedBadgeSnippets(orgUrl, theme)[format];

  return (
    <div className="mt-4 border-t border-[var(--line)] pt-4">
      <p className="text-[13.5px] font-medium text-[var(--fg)]">Add a badge</p>
      <p className="mt-1 text-[13px] leading-relaxed text-[var(--fg-3)]">
        Show that your release notes are listed. The badge links to this page.
      </p>

      <div role="radiogroup" aria-label="Badge style" className="mt-3 flex flex-wrap gap-2">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={theme === t.id}
            onClick={() => setTheme(t.id)}
            className={`rounded-[8px] border p-2 transition-colors ${t.swatch} ${
              theme === t.id
                ? "border-[var(--fg-3)]"
                : "border-[var(--line)] hover:border-[var(--fg-4)]"
            }`}
          >
            {/* Static SVG from /public; next/image adds nothing for a 1KB vector. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={listedBadgeImageUrl(t.id)}
              alt={`${t.label} badge`}
              width={118}
              height={24}
              className="block"
            />
          </button>
        ))}
      </div>

      <div className="mt-3 overflow-hidden rounded-[8px] border border-[var(--line)]">
        <div className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--surface)] px-2">
          <div role="tablist" aria-label="Snippet format" className="flex">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={format === f.id}
                onClick={() => setFormat(f.id)}
                className={`px-2 py-1.5 text-[12px] font-medium ${
                  format === f.id ? "text-[var(--fg)]" : "text-[var(--fg-3)] hover:text-[var(--fg)]"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => copy(snippet)}
            className="inline-flex items-center gap-1 px-1 py-1.5 text-[12px] text-[var(--fg-3)] hover:text-[var(--fg)]"
          >
            <CopyIcon copied={copied} size={12} />
            <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
        <pre className="overflow-x-auto bg-[var(--surface-2)] p-2.5 font-mono text-[11.5px] leading-relaxed text-[var(--fg-2)] whitespace-pre-wrap break-all">
          {snippet}
        </pre>
      </div>
    </div>
  );
}
