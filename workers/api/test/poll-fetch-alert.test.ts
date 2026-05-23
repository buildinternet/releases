import { describe, it, expect } from "bun:test";
import {
  formatPollFetchAlert,
  type PollFetchFailure,
  type PollFetchSourceDetail,
} from "../src/lib/poll-fetch-alert.js";

const SCHEDULED = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

function detail(
  over: Partial<PollFetchSourceDetail> & { sourceId: string },
): PollFetchSourceDetail {
  return {
    sourceName: null,
    sourceSlug: null,
    sourceUrl: null,
    sourceType: null,
    orgName: null,
    orgSlug: null,
    ...over,
  };
}

const vercelDetail = detail({
  sourceId: "src_next",
  sourceName: "Next.js",
  sourceSlug: "next-js",
  sourceUrl: "https://github.com/vercel/next.js/releases",
  sourceType: "github",
  orgName: "Vercel",
  orgSlug: "vercel",
});

describe("formatPollFetchAlert", () => {
  it("names the org and source instead of only the id", () => {
    const failures: PollFetchFailure[] = [
      { sourceId: "src_next", stepName: "fetch", error: "Timed out after 5m" },
    ];
    const { subject, text, html } = formatPollFetchAlert(
      failures,
      new Map([["src_next", vercelDetail]]),
      SCHEDULED,
    );

    // Subject names the source for the single-failure case.
    expect(subject).toContain("Vercel — Next.js");
    expect(subject).toContain("failed at fetch");
    expect(subject).toContain(`scheduledTime=${SCHEDULED}`);

    // Text body carries the human identity + the supporting details.
    expect(text).toContain("Vercel — Next.js");
    expect(text).toContain("org/source:  vercel/next-js");
    expect(text).toContain("url:         https://github.com/vercel/next.js/releases");
    expect(text).toContain("type:        github");
    expect(text).toContain("step:        fetch");
    expect(text).toContain("error:       Timed out after 5m");
    // The opaque id stays available for admin lookup, but is no longer alone.
    expect(text).toContain("source id:   src_next");

    expect(html).toContain("Vercel — Next.js");
    expect(html).toContain("vercel/next-js");
    expect(html).toContain('href="https://github.com/vercel/next.js/releases"');
  });

  it("falls back to the bare source id when nothing resolved", () => {
    const failures: PollFetchFailure[] = [
      { sourceId: "src_ghost", stepName: "embed", error: "boom" },
    ];
    const { subject, text } = formatPollFetchAlert(failures, new Map(), SCHEDULED);
    expect(subject).toContain("src_ghost failed at embed");
    expect(text).toContain("src_ghost");
    expect(text).toContain("error:       boom");
    // No org/source/url/type lines when unresolved.
    expect(text).not.toContain("org/source:");
    expect(text).not.toContain("url:");
  });

  it("stays count-based in the subject when multiple sources fail", () => {
    const failures: PollFetchFailure[] = [
      { sourceId: "src_next", stepName: "fetch", error: "a" },
      { sourceId: "src_ghost", stepName: "embed", error: "b" },
    ];
    const { subject, text } = formatPollFetchAlert(
      failures,
      new Map([["src_next", vercelDetail]]),
      SCHEDULED,
    );
    expect(subject).toContain("2 source(s) failed");
    // Both the resolved and the unresolved source appear.
    expect(text).toContain("Vercel — Next.js");
    expect(text).toContain("src_ghost");
  });

  it("escapes HTML-significant characters in the html body", () => {
    const failures: PollFetchFailure[] = [
      { sourceId: "src_x", stepName: "fetch", error: 'bad <tag> & "quote"' },
    ];
    const evil = detail({
      sourceId: "src_x",
      sourceName: "A <b> & co",
      sourceSlug: "a-b",
      orgName: "Org",
      orgSlug: "org",
    });
    const { html } = formatPollFetchAlert(failures, new Map([["src_x", evil]]), SCHEDULED);
    expect(html).toContain("A &lt;b&gt; &amp; co");
    expect(html).toContain("bad &lt;tag&gt; &amp; &quot;quote&quot;");
    expect(html).not.toContain("<tag>");
  });

  it("uses slug when name is missing and degrades partial identity", () => {
    const failures: PollFetchFailure[] = [{ sourceId: "src_p", stepName: "fetch", error: "e" }];
    const partial = detail({
      sourceId: "src_p",
      sourceSlug: "only-slug",
      orgSlug: "acme",
    });
    const { text } = formatPollFetchAlert(failures, new Map([["src_p", partial]]), SCHEDULED);
    expect(text).toContain("acme — only-slug");
    expect(text).toContain("org/source:  acme/only-slug");
  });
});
