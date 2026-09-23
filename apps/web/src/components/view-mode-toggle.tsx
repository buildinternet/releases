export type ViewMode = "heatmap" | "chart";

interface ViewModeToggleProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

const activeCls = "bg-white dark:bg-stone-700 text-stone-900 dark:text-stone-100 shadow-sm";
const inactiveCls =
  "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300";

export function ViewModeToggle({ viewMode, onViewModeChange }: ViewModeToggleProps) {
  return (
    <div className="inline-flex bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-md p-0.5 mb-4">
      <button
        className={`px-3 py-1 text-xs font-medium rounded transition-[color,background-color,box-shadow] ${viewMode === "heatmap" ? activeCls : inactiveCls}`}
        onClick={() => onViewModeChange("heatmap")}
      >
        Activity
      </button>
      <button
        className={`px-3 py-1 text-xs font-medium rounded transition-[color,background-color,box-shadow] ${viewMode === "chart" ? activeCls : inactiveCls}`}
        onClick={() => onViewModeChange("chart")}
      >
        Timeline
      </button>
    </div>
  );
}
