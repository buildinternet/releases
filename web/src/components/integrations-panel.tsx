import { PanelGrid } from "@/components/account/settings-section";
import { PreviewBanner, cardClass, smallButtonClass } from "@/components/account/ui";
import { PromoRail } from "@/components/account/promo-rail";
import { CheckIcon, IntegrationsIcon } from "@/components/account/icons";

/**
 * Workspace "Integrations" — preview/static. No backend yet; faithful mockup
 * with the MCP/CLI promo rail, withheld from the nav.
 */
const INTEGRATIONS = [
  { name: "Slack", desc: "Post new releases to a channel.", initial: "SL", connected: true },
  { name: "GitHub", desc: "Sync sources, stars, and tags.", initial: "GH", connected: true },
  { name: "Linear", desc: "Link releases to issues and cycles.", initial: "LI", connected: false },
  { name: "Discord", desc: "Notify a server when sources ship.", initial: "DC", connected: false },
];

export function IntegrationsPanel() {
  return (
    <PanelGrid aside={<PromoRail />}>
      <div className="flex flex-col gap-6">
        <PreviewBanner
          title="Integrations are in preview"
          icon={<IntegrationsIcon className="h-4 w-4" />}
        >
          Connecting the tools your team already works in is coming soon.
        </PreviewBanner>

        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {INTEGRATIONS.map((ig) => (
            <div key={ig.name} className={`flex items-start gap-3.5 ${cardClass} p-[17px]`}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-stone-100 font-mono text-[15px] font-semibold text-stone-700 dark:bg-stone-800 dark:text-stone-200">
                {ig.initial}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  {ig.name}
                </div>
                <p className="mt-0.5 mb-3 text-[12.5px] leading-snug text-stone-500 dark:text-stone-400">
                  {ig.desc}
                </p>
                {ig.connected ? (
                  <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--accent)]">
                    <CheckIcon className="h-3.5 w-3.5" />
                    Connected
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled
                    className={`${smallButtonClass} cursor-not-allowed opacity-60`}
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </PanelGrid>
  );
}
