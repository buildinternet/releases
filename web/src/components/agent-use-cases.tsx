import Link from "next/link";

/**
 * Homepage block spelling out the non-obvious agent use cases — the
 * landscape-awareness jobs ("what is the rest of the market shipping?") that
 * don't read off the CLI demo on their own. Prompt-first: each entry leads
 * with the plain-spoken question an agent answers using the registry, with a
 * one-line answer beneath — a quiet list, no cards, matching the page's
 * terminal idiom. Lives at the very bottom of the page (intro material;
 * returning visitors get the changing content first) —
 * {@link AgentUseCasesJumpLink} under the demo deep-links here for
 * first-timers.
 */
const SECTION_ID = "why-agents";

const USE_CASES: { prompt: string; answer: string }[] = [
  {
    prompt: "What shipped across our stack this week?",
    answer: "Every release from the tools you use, even the ones that never got a version number.",
  },
  {
    prompt: "Who's shipped integrations with us lately?",
    answer: "Products that just added a connection to yours, or to the tools you build on.",
  },
  {
    prompt: "What should go on the roadmap next?",
    answer: "What the rest of tech is shipping, as input for deciding what to build next.",
  },
];

export function AgentUseCases() {
  return (
    <section
      id={SECTION_ID}
      aria-labelledby="agent-use-cases-heading"
      className="max-w-xl mx-auto px-6 pb-16 scroll-mt-8"
    >
      <div className="text-center mb-6">
        {/* Deliberately NOT the RECENT/FEATURED micro-label treatment: those
            label data tables, this is narrative framing for first-timers and
            needs to read as a heading, not a tag. */}
        <h2
          id="agent-use-cases-heading"
          className="text-[17px] font-semibold tracking-tight text-stone-900 dark:text-stone-100"
        >
          What agents ask
        </h2>
        <p className="mt-1.5 text-[13px] text-stone-500 dark:text-stone-400">
          Pulling the latest GitHub release is the easy part. This is the rest: launches,
          changelogs, and announcements from across the web, in a shape your agent can read.
        </p>
      </div>
      <ul className="space-y-5">
        {USE_CASES.map((uc) => (
          <li key={uc.prompt}>
            <p className="font-mono text-[13px] leading-snug text-stone-700 dark:text-stone-200">
              <span aria-hidden="true" className="select-none text-stone-400 dark:text-stone-600">
                &gt;{" "}
              </span>
              &ldquo;{uc.prompt}&rdquo;
            </p>
            <p className="mt-1 pl-4 text-[13px] leading-snug text-stone-500 dark:text-stone-400">
              {uc.answer}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-center text-[12px] text-stone-400 dark:text-stone-500">
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
 * Chip-style anchor under the CLI demo that jumps to the use-case section at
 * the bottom of the page. Deliberately NOT the underlined-footnote treatment
 * {@link SignupCta} uses — two identical stacked footnotes read as one blob
 * of fine print, and this one earns the button-ish affordance (it navigates
 * within the page; the chevron signals the scroll).
 */
export function AgentUseCasesJumpLink() {
  return (
    <p className="mt-4 text-center">
      <a
        href={`#${SECTION_ID}`}
        className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-[12px] text-stone-500 transition-colors hover:border-stone-300 hover:text-stone-700 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400 dark:hover:border-stone-600 dark:hover:text-stone-200"
      >
        New here? See what agents use this for
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 5v14" />
          <path d="m19 12-7 7-7-7" />
        </svg>
      </a>
    </p>
  );
}
