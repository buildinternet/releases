import {
  PanelGrid,
  Aside,
  PreviewBanner,
  listCardClass,
  fieldLabelClass,
  inputClass,
  primaryButtonClass,
} from "@releases/design-system";
import { StarIcon, CollectionsIcon, CloseIcon } from "@/components/account/icons";

/**
 * Personal "Collections" — preview/static. No backend yet (withheld from the nav
 * via SHOW_WIP_PANELS), so this renders the design's layout with sample content
 * and a disabled create form.
 */
const SAMPLE_MATCHES = [
  { initial: "LI", title: "Slack notifications for triage handoff", company: "Linear", time: "2d" },
  {
    initial: "V",
    title: "Slack integration is now generally available",
    company: "Vercel",
    time: "5d",
  },
  { initial: "N", title: "Improved Slack link unfurling", company: "Notion", time: "1w" },
];
const COMPANIES = ["Slack", "Vercel", "Linear"];
const KEYWORDS = ["integrations", "webhooks"];

function Chip({ label, mono }: { label: string; mono?: boolean }) {
  return (
    <span
      className={`inline-flex h-[26px] items-center gap-1.5 rounded-md bg-stone-100 pl-2.5 pr-1.5 text-[12.5px] text-stone-700 dark:bg-stone-800 dark:text-stone-200 ${
        mono ? "font-mono" : ""
      }`}
    >
      {label}
      <CloseIcon className="h-3 w-3 text-stone-400" />
    </span>
  );
}

export function CollectionsPanel() {
  return (
    <PanelGrid
      aside={
        <Aside label="How it works">
          <p className="text-[13px] leading-relaxed text-stone-600 dark:text-stone-300">
            We scan every release we track and surface only the ones that match your filters — in a
            private feed you can follow over RSS.
          </p>
        </Aside>
      }
    >
      <div className="flex flex-col gap-9">
        <PreviewBanner
          title="Personal collections are in preview"
          icon={<StarIcon className="h-4 w-4" />}
        >
          Build a private feed from the companies and topics you care about. This is a preview of
          what's coming.
        </PreviewBanner>

        <section>
          <div className="mb-3 text-sm font-semibold text-stone-900 dark:text-stone-100">
            Your collections
          </div>
          <div className={listCardClass}>
            <div className="flex items-center gap-3 px-4 py-3.5">
              <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-[var(--accent-soft)] text-[var(--accent)]">
                <CollectionsIcon />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold text-stone-900 dark:text-stone-100">
                  Slack integrations
                </div>
                <div className="font-mono text-[12.5px] text-stone-400 dark:text-stone-500">
                  3 companies · 2 keywords · 42 matches
                </div>
              </div>
            </div>
            <div className="border-t border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900/40">
              {SAMPLE_MATCHES.map((r) => (
                <div
                  key={r.title}
                  className="flex items-center gap-3 border-t border-stone-200 px-4 py-2.5 first:border-t-0 dark:border-stone-800"
                >
                  <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-stone-200 bg-white font-mono text-[10.5px] font-semibold text-stone-500 dark:border-stone-700 dark:bg-stone-950">
                    {r.initial}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-stone-800 dark:text-stone-200">
                    {r.title}
                  </span>
                  <span className="shrink-0 font-mono text-[11.5px] text-stone-400 dark:text-stone-500">
                    {r.company} · {r.time}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section>
          <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            New collection
          </div>
          <p className="mt-1 mb-4 text-[13px] text-stone-500 dark:text-stone-400">
            Match on companies, keywords, or both.
          </p>
          <div className="flex flex-col gap-4">
            <div>
              <span className={fieldLabelClass}>Name</span>
              <input disabled placeholder="e.g. Slack integrations" className={inputClass} />
            </div>
            <div>
              <span className={fieldLabelClass}>Companies</span>
              <div className="flex flex-wrap items-center gap-2 rounded-[9px] border border-stone-200 bg-white p-2 dark:border-stone-700 dark:bg-stone-950">
                {COMPANIES.map((c) => (
                  <Chip key={c} label={c} />
                ))}
              </div>
            </div>
            <div>
              <span className={fieldLabelClass}>Keywords</span>
              <div className="flex flex-wrap items-center gap-2 rounded-[9px] border border-stone-200 bg-white p-2 dark:border-stone-700 dark:bg-stone-950">
                {KEYWORDS.map((k) => (
                  <Chip key={k} label={k} mono />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                disabled
                className={`${primaryButtonClass} cursor-not-allowed opacity-60`}
              >
                Create collection
              </button>
              <span className="text-[12px] text-stone-400 dark:text-stone-500">
                Available when collections ship
              </span>
            </div>
          </div>
        </section>
      </div>
    </PanelGrid>
  );
}
