"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Page-level "Copy for agent" control on the org page: a split button whose
 * primary action copies a ready-to-paste agent prompt, with a dropdown for the
 * page link and a Markdown export. Mirrors the per-release hover copy actions in
 * the Releases tab, scaled up to the whole org.
 *
 * The canonical page URL is resolved from `window.location.origin` at click time
 * (falling back to releases.sh) so the copied text is correct across prod,
 * preview, and local dev. "Copy as Markdown" fetches the org's `.md` route and
 * copies the body; on any failure it falls back to copying the `.md` URL.
 */
export function AgentCopyButton({
  orgName,
  orgSlug,
  productNames,
}: {
  orgName: string;
  orgSlug: string;
  productNames: string[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timerRef.current && clearTimeout(timerRef.current)), []);

  const flash = () => {
    setMenuOpen(false);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1600);
  };

  const pageUrl = () => {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "https://releases.sh";
    return `${origin}/${orgSlug}`;
  };

  const write = (text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard can reject without a user gesture / in insecure contexts.
    }
  };

  const productClause =
    productNames.length > 0 ? ` It aggregates releases across ${formatList(productNames)}.` : "";

  const copyPrompt = () => {
    write(
      `Read the release tracker for ${orgName} on releases.sh: ${pageUrl()}\n\n` +
        `It aggregates ${orgName}'s releases from across the web into one timeline.${productClause} ` +
        `Review what shipped recently and flag anything relevant to my work, with links.`,
    );
    flash();
  };

  const copyLink = () => {
    write(pageUrl());
    flash();
  };

  const copyMarkdown = async () => {
    const url = `${pageUrl()}.md`;
    try {
      const res = await fetch(`/${orgSlug}.md`);
      write(res.ok ? await res.text() : url);
    } catch {
      write(url);
    }
    flash();
  };

  return (
    <div className="relative shrink-0">
      <div className="flex h-[42px] items-stretch overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
        <button
          type="button"
          onClick={copyPrompt}
          title="Copy a prompt for your agent"
          className="flex items-center gap-2 px-3.5 text-[13px] font-medium text-[var(--fg)] transition-colors hover:bg-[var(--surface-2)]"
        >
          {copied ? (
            <CheckIcon className="h-[15px] w-[15px] text-[var(--accent)]" />
          ) : (
            <SparkleIcon className="h-[15px] w-[15px] text-[var(--accent)]" />
          )}
          {copied ? "Copied!" : "Copy for agent"}
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-label="More copy options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex w-9 items-center justify-center border-l border-[var(--line)] text-[var(--fg-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
        >
          <ChevronIcon
            className={`h-3.5 w-3.5 transition-transform ${menuOpen ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />
          <div
            role="menu"
            className="account-menu-pop absolute right-0 top-12 z-40 w-[266px] rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1.5 shadow-[0_16px_40px_-14px_rgba(0,0,0,0.35)]"
          >
            <MenuItem
              onClick={copyPrompt}
              icon={<SparkleIcon className="h-[15px] w-[15px]" />}
              iconAccent
              title="Copy agent prompt"
              subtitle="Paste into Claude or Cursor"
            />
            <MenuItem
              onClick={copyLink}
              icon={<LinkIcon className="h-[15px] w-[15px]" />}
              title="Copy page link"
              subtitle={`releases.sh/${orgSlug}`}
              subtitleMono
            />
            <MenuItem
              onClick={copyMarkdown}
              icon={<MarkdownIcon className="h-[15px] w-[15px]" />}
              title="Copy as Markdown"
              subtitle="Full page as .md"
            />
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  icon,
  iconAccent,
  title,
  subtitle,
  subtitleMono,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  iconAccent?: boolean;
  title: string;
  subtitle: string;
  subtitleMono?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-2)]"
    >
      <span
        className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] ${
          iconAccent ? "text-[var(--accent)]" : "text-[var(--fg-2)]"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-[var(--fg)]">{title}</span>
        <span
          className={`block truncate text-[11.5px] text-[var(--fg-3)] ${subtitleMono ? "font-mono" : ""}`}
        >
          {subtitle}
        </span>
      </span>
    </button>
  );
}

function formatList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={1.5} {...stroke} className={className}>
      <path d="M12 3.5l1.5 4.2L18 9l-4.5 1.3L12 14.5l-1.5-4.2L6 9l4.5-1.3z" />
      <path d="M18.6 14.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={2.2} {...stroke} className={className}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={1.7} {...stroke} className={className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={1.6} {...stroke} className={className}>
      <path d="M10 13a4 4 0 0 0 5.7.3l2.5-2.5a4 4 0 0 0-5.7-5.7l-1.3 1.3" />
      <path d="M14 11a4 4 0 0 0-5.7-.3l-2.5 2.5a4 4 0 0 0 5.7 5.7l1.3-1.3" />
    </svg>
  );
}

function MarkdownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={1.5} {...stroke} className={className}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M6.5 14.5V9.5l2.5 3 2.5-3v5" />
      <path d="M15.5 9.5v5M14 13l1.5 1.7 1.5-1.7" />
    </svg>
  );
}
