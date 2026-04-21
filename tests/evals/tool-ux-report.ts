#!/usr/bin/env bun
/**
 * Render a markdown comparison between old and new tool-UX eval runs.
 *
 * Input: JSON file containing an array of EvalRun objects (schema in the
 * fixture README). Pass the path as the first argument.
 *
 *   bun tests/evals/tool-ux-report.ts runs.json
 *
 * Output: markdown to stdout.
 */

import { readFileSync } from "node:fs";
import { TASKS, type ToolUxTask } from "./fixtures/tool-ux/tasks.js";

interface EvalRun {
  variant: "old" | "new";
  taskId: string;
  runIndex: number;
  toolCalls: Array<{ name: string; input?: unknown }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  elapsedMs: number;
  finalResponse?: string;
  error?: string;
}

interface Aggregate {
  variant: "old" | "new";
  taskId: string;
  runs: number;
  toolCallsMedian: number;
  totalTokensMedian: number;
  wrongToolRate: number;
  errorRate: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function totalTokens(u: EvalRun["usage"]): number {
  return u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0);
}

function aggregate(runs: EvalRun[], task: ToolUxTask, variant: "old" | "new"): Aggregate {
  const matching = runs.filter((r) => r.taskId === task.id && r.variant === variant);
  const expected = new Set(task.expected[variant]);

  let wrongToolCalls = 0;
  let totalCalls = 0;
  let errors = 0;

  for (const run of matching) {
    if (run.error) errors++;
    for (const call of run.toolCalls) {
      totalCalls++;
      if (!expected.has(call.name)) wrongToolCalls++;
    }
  }

  return {
    variant,
    taskId: task.id,
    runs: matching.length,
    toolCallsMedian: median(matching.map((r) => r.toolCalls.length)),
    totalTokensMedian: median(matching.map((r) => totalTokens(r.usage))),
    wrongToolRate: totalCalls === 0 ? 0 : wrongToolCalls / totalCalls,
    errorRate: matching.length === 0 ? 0 : errors / matching.length,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function delta(oldV: number, newV: number): string {
  if (oldV === 0 && newV === 0) return "—";
  if (oldV === 0) return `+${newV.toFixed(1)}`;
  const diff = newV - oldV;
  const pctDiff = (diff / oldV) * 100;
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)} (${sign}${pctDiff.toFixed(0)}%)`;
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: bun tests/evals/tool-ux-report.ts <runs.json>");
    process.exit(1);
  }

  const runs: EvalRun[] = JSON.parse(readFileSync(path, "utf-8"));

  const lines: string[] = [];
  lines.push("# Tool-UX eval report");
  lines.push("");
  lines.push(`Runs analyzed: ${runs.length}`);
  lines.push(`Tasks: ${TASKS.length}`);
  lines.push("");

  // ── Per-task comparison ──
  lines.push("## Per-task comparison");
  lines.push("");
  lines.push(
    "| Task | Old tool calls | New tool calls | Δ | Old tokens | New tokens | Δ | Wrong-tool (old / new) | Errors (old / new) |",
  );
  lines.push("|---|---:|---:|---|---:|---:|---|---:|---:|");

  let oldCallsTotal = 0;
  let newCallsTotal = 0;
  let oldTokensTotal = 0;
  let newTokensTotal = 0;

  for (const task of TASKS) {
    const o = aggregate(runs, task, "old");
    const n = aggregate(runs, task, "new");
    oldCallsTotal += o.toolCallsMedian;
    newCallsTotal += n.toolCallsMedian;
    oldTokensTotal += o.totalTokensMedian;
    newTokensTotal += n.totalTokensMedian;

    lines.push(
      `| ${task.id} | ${o.toolCallsMedian.toFixed(1)} | ${n.toolCallsMedian.toFixed(1)} | ${delta(o.toolCallsMedian, n.toolCallsMedian)} | ${Math.round(o.totalTokensMedian)} | ${Math.round(n.totalTokensMedian)} | ${delta(o.totalTokensMedian, n.totalTokensMedian)} | ${pct(o.wrongToolRate)} / ${pct(n.wrongToolRate)} | ${pct(o.errorRate)} / ${pct(n.errorRate)} |`,
    );
  }

  lines.push("");
  lines.push("## Totals (sum of medians)");
  lines.push("");
  lines.push(
    `- Tool calls: ${oldCallsTotal.toFixed(1)} → ${newCallsTotal.toFixed(1)} (${delta(oldCallsTotal, newCallsTotal)})`,
  );
  lines.push(
    `- Tokens: ${Math.round(oldTokensTotal)} → ${Math.round(newTokensTotal)} (${delta(oldTokensTotal, newTokensTotal)})`,
  );
  lines.push("");

  // ── Tool-call histogram ──
  lines.push("## Tool-call frequency");
  lines.push("");

  const oldHist = new Map<string, number>();
  const newHist = new Map<string, number>();
  for (const run of runs) {
    const target = run.variant === "old" ? oldHist : newHist;
    for (const call of run.toolCalls) {
      target.set(call.name, (target.get(call.name) ?? 0) + 1);
    }
  }
  const allTools = new Set([...oldHist.keys(), ...newHist.keys()]);
  lines.push("| Tool | Old | New |");
  lines.push("|---|---:|---:|");
  for (const tool of [...allTools].toSorted()) {
    lines.push(`| ${tool} | ${oldHist.get(tool) ?? 0} | ${newHist.get(tool) ?? 0} |`);
  }
  lines.push("");

  // ── Coverage warnings ──
  const warnings: string[] = [];
  for (const task of TASKS) {
    for (const variant of ["old", "new"] as const) {
      const count = runs.filter((r) => r.taskId === task.id && r.variant === variant).length;
      if (count === 0) warnings.push(`- ${task.id} / ${variant}: no runs`);
      else if (count < 3)
        warnings.push(`- ${task.id} / ${variant}: only ${count} run(s); aim for 3+`);
    }
  }
  if (warnings.length > 0) {
    lines.push("## Coverage warnings");
    lines.push("");
    lines.push(...warnings);
    lines.push("");
  }

  console.log(lines.join("\n"));
}

main();
