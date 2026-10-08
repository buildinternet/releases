import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DigestCoveredRelease } from "@/lib/api";
import { DigestWeekGlance } from "./digest-week-glance";

const org = (slug: string, name: string) => ({ slug, name, avatarUrl: null, githubHandle: null });

function rel(
  id: string,
  product: { slug: string; name: string },
  orgInfo: ReturnType<typeof org>,
  importance: number | null,
): DigestCoveredRelease {
  return {
    id,
    title: `Title ${id}`,
    path: `/release/${id}`,
    url: null,
    org: orgInfo,
    product,
    importance,
    composition: { features: 2, enhancements: 1, bugs: 3 },
  };
}

const codex = { slug: "codex", name: "Codex" };
const devin = { slug: "devin", name: "Devin" };
const openai = org("openai", "OpenAI");
const cognition = org("cognition", "Cognition");

const releases: DigestCoveredRelease[] = [
  rel("r1", codex, openai, 5),
  rel("r2", codex, openai, 4),
  rel("r3", devin, cognition, 4),
  rel("r4", codex, openai, 2),
  rel("r5", devin, cognition, null),
  rel("r6", devin, cognition, 1),
];

const sections = [
  { heading: "Models", anchor: "new-models", lede: "", releaseIds: ["r1", "r2"] },
  { heading: "Devin", anchor: "devin-moves", lede: "", releaseIds: ["r3"] },
];

describe("DigestWeekGlance", () => {
  test("renders one tile per product and the five biggest releases", () => {
    const html = renderToStaticMarkup(<DigestWeekGlance releases={releases} sections={sections} />);
    expect(html).toContain("The week at a glance");
    expect(html.match(/aria-pressed=/g)).toHaveLength(2);
    expect(html).toContain(
      'aria-label="Codex: 3 releases, 2 major or landmark. Select to filter the list."',
    );
    expect(html).toContain("Tile size reflects impact");
    expect(html).toContain("Biggest releases");
    const rowTitles = [...html.matchAll(/<span>(Title r\d)<\/span>/g)].map((m) => m[1]);
    expect(rowTitles).toHaveLength(5);
    expect(rowTitles.slice(0, 3)).toEqual(["Title r1", "Title r2", "Title r3"]);
  });

  test("rows link to their section anchor, falling back to the covered block", () => {
    const html = renderToStaticMarkup(<DigestWeekGlance releases={releases} sections={sections} />);
    expect(html).toContain('href="#new-models"');
    expect(html).toContain('href="#devin-moves"');
    expect(html).toContain('href="#releases-covered"');
  });

  test("hides the treemap and legend when only one product shipped", () => {
    const solo = releases.filter((r) => r.product?.slug === "codex");
    const html = renderToStaticMarkup(<DigestWeekGlance releases={solo} sections={sections} />);
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("Tile size reflects impact");
    expect(html).toContain("Biggest releases");
  });

  test("links to the week's replay", () => {
    const html = renderToStaticMarkup(
      <DigestWeekGlance releases={releases} sections={sections} replayHref="/w/replay" />,
    );
    expect(html).toContain('href="/w/replay"');
    expect(html).toContain("Replay the week");
  });

  test("skips the card, and so the replay link, under three releases", () => {
    const html = renderToStaticMarkup(
      <DigestWeekGlance
        releases={releases.slice(0, 2)}
        sections={sections}
        replayHref="/w/replay"
      />,
    );
    expect(html).toBe("");
  });
});
