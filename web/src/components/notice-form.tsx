// No "use client" directive: this is a client-only leaf consumed exclusively by
// the entity admin menus (themselves "use client"), so it inherits their client
// boundary. Keeping it off the client-entry list lets it take the parent's
// onSave / onClear callbacks without tripping the serializable-props rule.
import { useId, useState } from "react";
import type { Notice } from "@buildinternet/releases-core/notice";
import {
  buildNoticeFromDraft,
  draftFromNotice,
  type LinkMode,
  type NoticeDraft,
  NOTICE_MESSAGE_MAX,
} from "@/lib/notice-form";

const inputClass =
  "w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-200 text-[12px]";
const buttonClass =
  "px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50";

/**
 * Set / edit / clear the curator notice on an org, product, or source. Lives
 * inside each entity's admin dropdown; mounts fresh each time the menu opens so
 * it always pre-fills from the current notice. The parent owns the `pending`
 * transition and wires `onSave` / `onClear` to its own `run()` action helper.
 */
export function NoticeForm({
  notice,
  pending,
  onSave,
  onClear,
}: {
  notice?: Notice | null;
  pending: boolean;
  onSave: (notice: Notice) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState<NoticeDraft>(() => draftFromNotice(notice));
  const [localError, setLocalError] = useState<string | null>(null);
  const messageId = useId();
  const linkId = useId();
  const linkTextId = useId();

  const built = buildNoticeFromDraft(draft);
  const canSave = "notice" in built;
  const hasNotice = !!notice;

  function update(patch: Partial<NoticeDraft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setLocalError(null);
  }

  function handleSave() {
    const result = buildNoticeFromDraft(draft);
    if ("error" in result) {
      setLocalError(result.error);
      return;
    }
    onSave(result.notice);
  }

  const modeButton = (label: string, value: LinkMode) => (
    <button
      type="button"
      key={value}
      onClick={() => update({ linkMode: value })}
      disabled={pending}
      aria-pressed={draft.linkMode === value}
      className={`flex-1 px-2 py-1 rounded border text-[12px] disabled:opacity-50 ${
        draft.linkMode === value
          ? "border-stone-500 dark:border-stone-400 bg-stone-200 dark:bg-stone-700 text-stone-900 dark:text-stone-100"
          : "border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2 border-t border-stone-200 dark:border-stone-800 pt-3">
      <div className="font-medium text-stone-700 dark:text-stone-200">Notice</div>
      <p className="text-[12px] text-stone-500 dark:text-stone-400">
        A short advisory shown on this page — e.g. a rename or move. Optionally links to another
        registry entry or an external URL.
      </p>

      <label htmlFor={messageId} className="sr-only">
        Notice message
      </label>
      <textarea
        id={messageId}
        value={draft.message}
        onChange={(e) => update({ message: e.target.value })}
        rows={2}
        maxLength={NOTICE_MESSAGE_MAX}
        placeholder="Notice message…"
        className={inputClass}
      />

      <div className="flex gap-1.5">
        {modeButton("Internal", "internal")}
        {modeButton("External", "external")}
      </div>

      <label htmlFor={linkId} className="sr-only">
        {draft.linkMode === "internal" ? "Internal coordinate" : "External URL"}
      </label>
      <input
        id={linkId}
        type="text"
        value={draft.linkValue}
        onChange={(e) => update({ linkValue: e.target.value })}
        placeholder={
          draft.linkMode === "internal" ? "org or org/slug (optional)" : "https://… (optional)"
        }
        className={inputClass}
      />

      <label htmlFor={linkTextId} className="sr-only">
        Link label
      </label>
      <input
        id={linkTextId}
        type="text"
        value={draft.linkText}
        onChange={(e) => update({ linkText: e.target.value })}
        placeholder="Link label (optional)"
        className={inputClass}
      />

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={handleSave}
          disabled={pending || !canSave}
          className={`flex-1 ${buttonClass}`}
        >
          {pending ? "Saving…" : hasNotice ? "Update notice" : "Save notice"}
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={pending || !hasNotice}
          className={`flex-1 ${buttonClass}`}
        >
          Clear
        </button>
      </div>

      {localError && <div className="text-[12px] text-red-600 dark:text-red-400">{localError}</div>}
    </div>
  );
}
