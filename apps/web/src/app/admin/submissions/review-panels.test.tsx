import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RecommendationPlan, SubmissionItem } from "@/lib/admin-submissions";
import { ApproveForm, type ReviewActions } from "./review-panels.tsx";

const actions: ReviewActions = {
  plan: async () => ({ ok: false, error: "unused" }),
  approve: async () => ({ ok: false, error: "unused" }),
  promote: async () => ({ ok: false, error: "unused" }),
};

const item: SubmissionItem = {
  id: "rec_1",
  kind: "recommendation",
  createdAt: 1,
  title: "https://acme.test/changelog",
  detail: null,
  url: "https://acme.test/changelog",
  contact: "user@example.com",
  status: "new",
  archived: false,
  open: true,
  surface: "web",
  org: null,
};

const plan: RecommendationPlan = {
  recommendationId: "rec_1",
  evaluation: { recommendedMethod: "feed", confidence: "high", feedUrl: "https://acme.test/feed" },
  source: {
    name: "Acme Changelog",
    url: "https://acme.test/changelog",
    type: "feed",
    metadata: {},
  },
  matchedOrg: { slug: "acme", name: "Acme" },
  newOrg: { name: "Acme", slug: "acme", domain: "acme.test" },
  existingSource: null,
};

const render = (p: RecommendationPlan) =>
  renderToStaticMarkup(
    <ApproveForm plan={p} item={item} actions={actions} onDone={() => {}} onCancel={() => {}} />,
  );

describe("ApproveForm", () => {
  it("prefills the matched org, source and submitter email", () => {
    const html = render(plan);
    expect(html).toContain('value="acme"');
    expect(html).toContain('value="Acme Changelog"');
    expect(html).toContain("Email user@example.com");
    expect(html).toContain("https://acme.test/feed");
    expect(html).not.toContain("Already tracked");
  });

  it("offers a new org when nothing matched and warns about duplicates", () => {
    const html = render({
      ...plan,
      matchedOrg: null,
      existingSource: { orgSlug: "acme", slug: "changelog", name: "Acme Changelog" },
    });
    expect(html).toContain("Org name");
    expect(html).toContain('value="acme.test"');
    expect(html).toContain("Already tracked as acme/changelog");
  });
});
