import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalDetails } from "./device-approve-form.tsx";

const render = (purpose: Parameters<typeof ApprovalDetails>[0]["purpose"]) =>
  renderToStaticMarkup(
    <ApprovalDetails purpose={purpose} userCode="ABCD1234" email="dev@example.com" />,
  );

describe("ApprovalDetails", () => {
  it("never implies the purpose limits access: every purpose says it's full access", () => {
    for (const p of ["login", "keys", "publish-tokens", null] as const) {
      expect(render(p)).toContain("signs that device in to your account with full access");
    }
  });

  it("login: a read-only key, and the CLI signs out after", () => {
    const html = render("login");
    expect(html).toContain("Read catalog data");
    expect(html).toContain("releases login");
    expect(html).toContain("read-only");
    expect(html).toContain("then signs out");
  });

  it("keys: names the one-time account permission instead of a scope", () => {
    const html = render("keys");
    expect(html).toContain("Let the Releases CLI manage your API keys");
    expect(html).toContain("Manage your API keys");
    expect(html).toContain("One time");
    expect(html).toContain("releases keys");
    expect(html).not.toContain("Read catalog data");
  });

  it("publish-tokens: points revocation at the publish-token panel", () => {
    const html = render("publish-tokens");
    expect(html).toContain("Manage publish tokens");
    expect(html).toContain("releases publish-token");
    expect(html).toContain("/account/webhooks");
  });

  it("an older CLI (no purpose) is told it stays signed in", () => {
    const html = render(null);
    expect(html).toContain("Read catalog data");
    expect(html).toContain("stays signed in afterwards");
  });
});
