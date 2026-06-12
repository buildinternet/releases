import Link from "next/link";

/**
 * Homepage block spelling out the non-obvious agent use cases — the
 * landscape-awareness jobs ("what is the rest of the market shipping?") that
 * don't read off the CLI demo on their own. Static copy; each card pairs a
 * one-line job description with the kind of prompt an agent answers using the
 * registry. Sits directly under the demo so "here's the tool" flows into
 * "here's why an agent reaches for it".
 */
const USE_CASES: { title: string; body: string; prompt: string }[] = [
  {
    title: "Spot emerging trends",
    body: "Agents read what's shipping across your space and surface the patterns — the week everyone added a CLI, the shift toward task-based model routing — as roadmap context.",
    prompt: "What product trends are emerging across coding tools this quarter?",
  },
  {
    title: "Catch new integrations",
    body: "See when products in your ecosystem ship integrations with yours, or with the tools your users already rely on.",
    prompt: "Who announced integrations with our platform in the last 90 days?",
  },
  {
    title: "Vet tools before adopting",
    body: "Before recommending a dependency or vendor, an agent checks what they've shipped lately and how fast they're moving.",
    prompt: "Is this SDK still actively shipping? What changed in the past six months?",
  },
];

export function AgentUseCases() {
  return (
    <section aria-labelledby="agent-use-cases-heading" className="max-w-3xl mx-auto px-6 pb-12">
      <div className="text-center mb-5">
        <h2
          id="agent-use-cases-heading"
          className="text-[11px] font-bold uppercase tracking-wider text-stone-600 dark:text-stone-300"
        >
          Why agents query this
        </h2>
        <p className="mt-1.5 text-[13px] text-stone-500 dark:text-stone-400">
          Pulling the latest GitHub release is the easy part. The point is the rest of the landscape
          — launches, vendor changelogs, and announcements your agent can reason over.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {USE_CASES.map((uc) => (
          <div
            key={uc.title}
            className="rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40 p-4 flex flex-col gap-2"
          >
            <h3 className="text-[13px] font-semibold text-stone-900 dark:text-stone-100">
              {uc.title}
            </h3>
            <p className="text-[12px] leading-snug text-stone-500 dark:text-stone-400">{uc.body}</p>
            <p className="mt-auto pt-1 font-mono text-[11px] leading-snug text-stone-400 dark:text-stone-500">
              &ldquo;{uc.prompt}&rdquo;
            </p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-center text-[12px] text-stone-400 dark:text-stone-500">
        <Link
          href="/docs/why"
          className="underline decoration-stone-300 dark:decoration-stone-600 underline-offset-2 hover:text-stone-600 dark:hover:text-stone-300"
        >
          More on why this exists →
        </Link>
      </p>
    </section>
  );
}
