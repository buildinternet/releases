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
import {
  inputClass as settingsInputClass,
  textareaClass,
  secondaryButtonClass,
  smallButtonClass,
} from "@releases/design-system";

/** Compact styles for dropdown menus (product/source admin). */
const menuInputClass =
  "w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-200 text-[12px]";
const menuButtonClass =
  "px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50";

/**
 * Set / edit / clear the curator notice on an org, product, or source. Used by
 * entity admin surfaces (org admin tab + product/source/collection menus). The
 * parent owns the `pending` transition and wires `onSave` / `onClear` to its
 * own `run()` action helper. Pass `embedded` when the host already provides a
 * section title/description so the form skips its own header chrome.
 */
export function NoticeForm({
  notice,
  pending,
  onSave,
  onClear,
  embedded = false,
}: {
  notice?: Notice | null;
  pending: boolean;
  onSave: (notice: Notice) => void;
  onClear: () => void;
  /** Skip the built-in "Notice" heading when the parent already labels the section. */
  embedded?: boolean;
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

  const fieldClass = embedded ? settingsInputClass : menuInputClass;
  const areaClass = embedded ? textareaClass : menuInputClass;
  const actionClass = embedded ? secondaryButtonClass : menuButtonClass;
  const compactActionClass = embedded ? smallButtonClass : menuButtonClass;

  const modeButton = (label: string, value: LinkMode) => (
    <button
      type="button"
      key={value}
      onClick={() => update({ linkMode: value })}
      disabled={pending}
      aria-pressed={draft.linkMode === value}
      className={`flex-1 rounded border px-2 py-1.5 text-[12.5px] disabled:opacity-50 ${
        draft.linkMode === value
          ? "border-stone-500 bg-stone-200 text-stone-900 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-100"
          : "border-stone-300 bg-stone-50 text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      className={
        embedded ? "space-y-2.5" : "space-y-2 border-t border-stone-200 pt-3 dark:border-stone-800"
      }
    >
      {!embedded && (
        <>
          <div className="font-medium text-stone-700 dark:text-stone-200">Notice</div>
          <p className="text-[12px] text-stone-500 dark:text-stone-400">
            A short advisory shown on this page — e.g. a rename or move. Optionally links to another
            registry entry or an external URL.
          </p>
        </>
      )}

      <label htmlFor={messageId} className="sr-only">
        Notice message
      </label>
      <textarea
        id={messageId}
        value={draft.message}
        onChange={(e) => update({ message: e.target.value })}
        rows={embedded ? 3 : 2}
        maxLength={NOTICE_MESSAGE_MAX}
        placeholder="Notice message…"
        className={areaClass}
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
        className={fieldClass}
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
        className={fieldClass}
      />

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={handleSave}
          disabled={pending || !canSave}
          className={`flex-1 ${actionClass}`}
        >
          {pending ? "Saving…" : hasNotice ? "Update notice" : "Save notice"}
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={pending || !hasNotice}
          className={`flex-1 ${compactActionClass}`}
        >
          Clear
        </button>
      </div>

      {localError && <div className="text-[12px] text-red-600 dark:text-red-400">{localError}</div>}
    </div>
  );
}
