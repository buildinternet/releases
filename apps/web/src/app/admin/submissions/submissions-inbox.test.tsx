import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubmissionsResponse } from "@/lib/admin-submissions";
import { SubmissionsInbox, type SubmissionsActions } from "./submissions-inbox.tsx";

const noopActions: SubmissionsActions = {
  list: async () => ({ ok: true, data: { items: [], openCounts: emptyCounts() } }),
  triage: async () => ({ ok: true }),
};

function emptyCounts(): SubmissionsResponse["openCounts"] {
  return { recommendation: 0, feedback: 0, "tracking-request": 0, claim: 0 };
}

describe("SubmissionsInbox", () => {
  it("renders every kind with its links and only offers triage on triageable rows", () => {
    const data: SubmissionsResponse = {
      openCounts: { recommendation: 1, feedback: 2, "tracking-request": 1, claim: 0 },
      items: [
        {
          id: "rec_1",
          kind: "recommendation",
          createdAt: 3000,
          title: "https://acme.test/changelog",
          detail: "Their new changelog",
          url: "https://acme.test/changelog",
          contact: "user@example.com",
          status: "new",
          archived: false,
          open: true,
          surface: "web",
          org: null,
        },
        {
          id: "org_1",
          kind: "tracking-request",
          createdAt: 2000,
          title: "Stub Co",
          detail: "Tracking requested for stub.test",
          url: "https://stub.test",
          contact: null,
          status: "stub",
          archived: false,
          open: true,
          surface: "web",
          org: { slug: "stubco", name: "Stub Co", domain: "stub.test" },
        },
      ],
    };
    const html = renderToStaticMarkup(
      <SubmissionsInbox initial={data} initialError={null} actions={noopActions} />,
    );
    expect(html).toContain("Source suggestion");
    expect(html).toContain("Tracking request");
    expect(html).toContain("mailto:user@example.com");
    expect(html).toContain('href="/stubco"');
    // "All" chip sums the open counts.
    expect(html).toMatch(/All<span[^>]*>4<\/span>/);
    // Triage controls appear once (the recommendation), not on the tracking request.
    expect(html.match(/>Triage</g)?.length).toBe(1);
    expect(html.match(/>Archive</g)?.length).toBe(1);
  });

  it("shows an empty state and a load error", () => {
    const html = renderToStaticMarkup(
      <SubmissionsInbox
        initial={{ items: [], openCounts: emptyCounts() }}
        initialError="API 403: forbidden"
        actions={noopActions}
      />,
    );
    expect(html).toContain("Inbox zero");
    expect(html).toContain("API 403: forbidden");
  });
});
