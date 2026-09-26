import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ACCOUNT_ACTIONS_LABEL } from "@/lib/entitlement";
import { ScopeGroups } from "./auth-flow.tsx";

describe("ScopeGroups", () => {
  it("adds the follows/webhooks row to the action group when accountActions is set", () => {
    const html = renderToStaticMarkup(
      <ScopeGroups appName="Claude" scopes={["read", "openid", "offline_access"]} accountActions />,
    );
    expect(html).toContain("What Claude can do");
    expect(html).toContain("Read catalog data");
    expect(html).toContain(ACCOUNT_ACTIONS_LABEL.title);
    // read + the account-actions row.
    expect(html).toMatch(/What Claude can do.*?>2</s);
  });

  it("renders the action group for an identity-only grant when accountActions is set", () => {
    const html = renderToStaticMarkup(
      <ScopeGroups appName="Claude" scopes={["openid"]} accountActions />,
    );
    expect(html).toContain("What Claude can do");
    expect(html).toContain(ACCOUNT_ACTIONS_LABEL.title);
  });

  it("leaves the row out by default (device approval)", () => {
    const html = renderToStaticMarkup(<ScopeGroups appName="CLI" scopes={["read"]} />);
    expect(html).toContain("Read catalog data");
    expect(html).not.toContain(ACCOUNT_ACTIONS_LABEL.title);
  });
});
