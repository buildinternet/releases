import { PanelGrid } from "@/components/account/settings-section";
import { cardClass, smallButtonClass } from "@/components/account/ui";

/**
 * Workspace "Danger zone" — static/withheld from the nav. Ownership transfer and
 * workspace deletion aren't wired yet; the controls are present but disabled so
 * the destructive surface ships visually without an unguarded live action.
 */
export function DangerPanel() {
  return (
    <PanelGrid>
      <div className="flex flex-col gap-4">
        <div className={`flex items-center gap-4 ${cardClass} p-[18px]`}>
          <div className="flex-1">
            <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Transfer ownership
            </div>
            <p className="mt-1 text-[13px] text-stone-500 dark:text-stone-400">
              Hand this workspace to another admin.
            </p>
          </div>
          <button
            type="button"
            disabled
            title="Coming soon"
            className={`${smallButtonClass} shrink-0 cursor-not-allowed opacity-60`}
          >
            Transfer
          </button>
        </div>

        <div className="flex items-center gap-4 rounded-xl border border-red-500/30 bg-red-50 p-[18px] dark:border-red-500/30 dark:bg-red-950/30">
          <div className="flex-1">
            <div className="text-sm font-semibold text-red-600 dark:text-red-400">
              Delete workspace
            </div>
            <p className="mt-1 text-[13px] text-stone-600 dark:text-stone-300">
              Permanently remove this workspace, its sources, and all members. This cannot be
              undone.
            </p>
          </div>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="inline-flex h-9 shrink-0 cursor-not-allowed items-center justify-center rounded-lg bg-red-600 px-4 text-[13px] font-semibold text-white opacity-60"
          >
            Delete
          </button>
        </div>
      </div>
    </PanelGrid>
  );
}
