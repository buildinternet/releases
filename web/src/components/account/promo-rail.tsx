"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { eyebrowClass } from "./ui";
import { McpIcon, TerminalIcon, ExternalLinkIcon } from "./icons";

/**
 * Context rail shown beside the Integrations and Webhooks & API panels — an
 * auto-advancing two-card carousel promoting the MCP server and the CLI (the
 * design's `promo` rail). Pauses nothing fancy; just rotates every 6s with dot
 * controls. Hidden below `lg` like the other asides.
 */
const CARDS = [
  {
    key: "mcp",
    Icon: McpIcon,
    eyebrow: "For your agent",
    title: "releases MCP server",
    body: "Point Claude or Cursor at releases — it can query releases, sources, and your collections directly, no copy-paste.",
    code: "npx @releases/mcp add",
    linkLabel: "MCP docs",
    href: "/docs",
    tone: "accent" as const,
  },
  {
    key: "cli",
    Icon: TerminalIcon,
    eyebrow: "For your terminal",
    title: "releases CLI",
    body: "Script feeds, exports, and webhook tests straight from the command line.",
    code: "brew install releases-sh/tap/releases",
    linkLabel: "CLI reference",
    href: "/docs",
    tone: "neutral" as const,
  },
];

export function PromoRail() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setIndex((i) => (i + 1) % CARDS.length), 6000);
    return () => clearInterval(t);
  }, []);

  const card = CARDS[index];
  const Icon = card.Icon;

  return (
    <aside className="hidden self-start overflow-hidden rounded-xl bg-stone-100 lg:sticky lg:top-20 lg:block dark:bg-stone-800/50">
      <div className="p-[18px]">
        <div className="mb-3 flex items-center gap-2">
          <span
            className={`flex h-[26px] w-[26px] items-center justify-center rounded-lg ${
              card.tone === "accent"
                ? "bg-[var(--accent)] text-[var(--on-accent)]"
                : "bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900"
            }`}
          >
            <Icon className="h-[15px] w-[15px]" />
          </span>
          <span className={`${eyebrowClass} text-[10.5px] text-stone-400 dark:text-stone-500`}>
            {card.eyebrow}
          </span>
        </div>
        <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">{card.title}</div>
        <p className="mt-1.5 mb-3 text-[13px] leading-relaxed text-stone-600 dark:text-stone-300">
          {card.body}
        </p>
        <code className="mb-3 block overflow-hidden rounded-lg border border-stone-200 bg-white px-2.5 py-2 font-mono text-[12px] text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100">
          <span className="block truncate">{card.code}</span>
        </code>
        <Link
          href={card.href}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--accent)]"
        >
          {card.linkLabel}
          <ExternalLinkIcon className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="flex gap-1.5 px-[18px] pb-4">
        {CARDS.map((c, i) => (
          <button
            key={c.key}
            type="button"
            aria-label={`Show ${c.title}`}
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
            className={`h-1.5 rounded-full transition-all ${
              i === index ? "w-[18px] bg-[var(--accent)]" : "w-1.5 bg-stone-300 dark:bg-stone-600"
            }`}
          />
        ))}
      </div>
    </aside>
  );
}
