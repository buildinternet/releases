import Link from "next/link";

/**
 * Homepage block spelling out the non-obvious agent use cases — the
 * landscape-awareness jobs ("what is the rest of the market shipping?") that
 * don't read off the CLI demo on their own. Static copy; each card pairs a
 * short job description with a plain-spoken prompt an agent answers using the
 * registry. Lives at the very bottom of the page (intro material; returning
 * visitors get the changing content first) — {@link AgentUseCasesJumpLink}
 * under the demo deep-links here for first-timers.
 */
const SECTION_ID = "why-agents";

const USE_CASES: { title: string; body: string; prompt: string }[] = [
  {
    title: "Spot emerging trends",
    body: "Agents read across your whole space and surface the patterns — the week everyone added a CLI, the shift toward task-based model routing.",
    prompt: "What's trending across dev tools this quarter?",
  },
  {
    title: "Catch new integrations",
    body: "Know when products in your ecosystem ship integrations with yours, or with the tools your users rely on.",
    prompt: "Who's shipped integrations with us lately?",
  },
  {
    title: "Stay current on your stack",
    body: "A rundown of everything your tools shipped — including launches that never made it into a version tag.",
    prompt: "What shipped across our stack this week?",
  },
];

export function AgentUseCases() {
  return (
    <section
      id={SECTION_ID}
      aria-labelledby="agent-use-cases-heading"
      className="max-w-3xl mx-auto px-6 pb-12 scroll-mt-8"
    >
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

/**
 * Small footnote link under the CLI demo that jumps to the use-case section
 * at the bottom of the page. Same visual treatment as {@link SignupCta}'s
 * footnote so the two stack as quiet siblings.
 */
export function AgentUseCasesJumpLink() {
  return (
    <p className="mt-3 text-center text-[12px] text-stone-400 dark:text-stone-500">
      <a
        href={`#${SECTION_ID}`}
        className="underline decoration-stone-300 dark:decoration-stone-600 underline-offset-2 hover:text-stone-600 dark:hover:text-stone-300"
      >
        New here? See what agents use this for
      </a>
    </p>
  );
}
