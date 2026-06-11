"use client";

import { useState } from "react";
import {
  DEFAULT_SITE_NOTICE_COLOR,
  isHexColor,
  type SiteNotice,
  type StoredSiteNotice,
} from "@buildinternet/releases-core/site-notice";
import { SiteNoticeView } from "@/components/site-notice-view";
import { setSiteNoticeAction } from "@/app/actions/site-notice";

const PRESETS: { label: string; color: string }[] = [
  { label: "Info", color: "#0081e7" },
  { label: "Success", color: "#16a34a" },
  { label: "Warning", color: "#d97706" },
  { label: "Danger", color: "#dc2626" },
  { label: "Neutral", color: "#44403c" },
];

const inputClass =
  "w-full border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";

export function NoticeForm({ current }: { current: StoredSiteNotice | null }) {
  const [active, setActive] = useState(current?.active ?? false);
  const [message, setMessage] = useState(current?.message ?? "");
  const [linkText, setLinkText] = useState(current?.linkText ?? "");
  const [href, setHref] = useState(current?.href ?? "");
  const [placement, setPlacement] = useState<SiteNotice["placement"]>(
    current?.placement ?? "banner",
  );
  const [color, setColor] = useState(current?.color ?? DEFAULT_SITE_NOTICE_COLOR);
  const [dismissible, setDismissible] = useState(current?.dismissible ?? false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const colorValid = isHexColor(color);
  const canSave = message.trim().length > 0 && message.length <= 280 && colorValid && !saving;

  const preview: StoredSiteNotice = {
    active: true,
    message: message || "Your notice preview",
    linkText: linkText || undefined,
    href: href || undefined,
    placement,
    color: colorValid ? color : DEFAULT_SITE_NOTICE_COLOR,
    dismissible,
    updatedAt: "preview",
  };

  async function onSave() {
    setSaving(true);
    setResult(null);
    const notice: SiteNotice = {
      active,
      message: message.trim(),
      linkText: linkText.trim() || undefined,
      href: href.trim() || undefined,
      placement,
      color,
      dismissible,
    };
    const res = await setSiteNoticeAction(notice);
    setResult(res.ok ? "Saved." : res.error);
    setSaving(false);
  }

  return (
    <div className="space-y-5">
      <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-stone-200">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Active (visible to visitors)
      </label>

      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Message ({message.length}/280)
        </label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value.slice(0, 280))}
          rows={2}
          className={inputClass}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
            Link text
          </label>
          <input
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
            Link URL (https://… or /path)
          </label>
          <input value={href} onChange={(e) => setHref(e.target.value)} className={inputClass} />
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Placement
        </span>
        <div className="flex gap-4 text-sm text-stone-700 dark:text-stone-200">
          {(["banner", "home"] as const).map((p) => (
            <label key={p} className="flex items-center gap-2">
              <input
                type="radio"
                name="placement"
                checked={placement === p}
                onChange={() => setPlacement(p)}
              />
              {p === "banner" ? "Top banner" : "Home card"}
            </label>
          ))}
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Color
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.color}
              type="button"
              onClick={() => setColor(p.color)}
              title={p.label}
              aria-label={p.label}
              style={{ backgroundColor: p.color }}
              className={`h-7 w-7 rounded-full border-2 ${color === p.color ? "border-stone-900 dark:border-stone-100" : "border-transparent"}`}
            />
          ))}
          <input
            value={color}
            onChange={(e) => setColor(e.target.value)}
            spellCheck={false}
            className={`ml-2 w-28 ${inputClass} ${colorValid ? "" : "border-red-500"}`}
          />
          <input
            type="color"
            value={colorValid ? color : DEFAULT_SITE_NOTICE_COLOR}
            onChange={(e) => setColor(e.target.value)}
            aria-label="Color picker"
            className="h-7 w-9 border border-stone-300 dark:border-stone-700"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-stone-200">
        <input
          type="checkbox"
          checked={dismissible}
          onChange={(e) => setDismissible(e.target.checked)}
        />
        Visitors can dismiss it
      </label>

      <div>
        <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Preview
        </span>
        <div className="border border-dashed border-stone-300 p-3 dark:border-stone-700">
          <SiteNoticeView notice={preview} variant={placement === "banner" ? "banner" : "card"} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className="border border-stone-900 bg-stone-900 px-4 py-1.5 text-sm text-white transition hover:bg-stone-700 disabled:opacity-50 dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
        >
          {saving ? "Saving…" : "Save notice"}
        </button>
        {result && <span className="text-sm text-stone-600 dark:text-stone-300">{result}</span>}
      </div>
    </div>
  );
}
