"use client";
import { useState } from "react";
import { Caret } from "./caret";
import { derivePipelineView, type Dot } from "./workflow-pipeline-logic";
import type { WorkflowStage, LastRun, AiPass } from "./use-source-workflow";

const DOT: Record<Dot, string> = {
  ok: "border-emerald-400 bg-emerald-500/30",
  err: "border-red-400 bg-red-500/30",
  neutral: "border-stone-500 bg-transparent",
  async: "border-amber-400 bg-amber-500/30",
};

function Step({
  s,
  last,
}: {
  s: ReturnType<typeof derivePipelineView>["content"][number];
  last: boolean;
}) {
  return (
    <div className="grid grid-cols-[14px_1fr_auto] gap-2.5 items-start relative py-1.5">
      <span className={`mt-0.5 h-2.5 w-2.5 rounded-full border-2 ${DOT[s.dot]}`} />
      {!last && (
        <span className="absolute left-[6px] top-5 bottom-[-6px] w-px bg-stone-200 dark:bg-stone-700" />
      )}
      <span>
        <span className="text-stone-900 dark:text-stone-100">{s.label}</span>
        {s.detail && <span className="block text-[10px] text-stone-400">{s.detail}</span>}
      </span>
      <span className="text-[10px] text-stone-500 text-right whitespace-nowrap">{s.outcome}</span>
    </div>
  );
}

export function WorkflowPipeline({
  stages,
  lastRun,
  aiPasses,
}: {
  stages: WorkflowStage[];
  lastRun: LastRun | null;
  aiPasses: AiPass[];
}) {
  const [open, setOpen] = useState(false);
  const { content, async: tail } = derivePipelineView(stages, lastRun, aiPasses);

  return (
    <div className="font-mono text-xs">
      {content.map((s, i) => (
        <Step key={s.key} s={s} last={i === content.length - 1 && !tail.length && !open} />
      ))}
      {tail.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1 flex items-center gap-2 text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
          >
            <span className="h-2.5 w-2.5 rounded-full border-2 border-amber-400 bg-amber-500/30" />
            {open ? "post-commit" : `post-commit (${tail.length})`}
            <Caret open={open} />
          </button>
          {open && (
            <div className="mt-1.5">
              {tail.map((s, i) => (
                <Step key={s.key} s={s} last={i === tail.length - 1} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
