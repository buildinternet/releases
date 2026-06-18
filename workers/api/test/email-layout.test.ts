import { describe, expect, it } from "bun:test";
import { appendHtmlFooter, appendTextFooter } from "../src/lib/email-layout.js";

describe("email layout footers", () => {
  it("appendTextFooter adds reason, links, and brand line", () => {
    const text = appendTextFooter("Hello.", {
      reason: "You signed up for Releases.",
      links: [{ label: "Account", href: "https://releases.sh/account" }],
    });
    expect(text).toContain("Hello.");
    expect(text).toContain("You signed up for Releases.");
    expect(text).toContain("Account: https://releases.sh/account");
    expect(text).toContain("releases.sh");
  });

  it("appendHtmlFooter escapes reason and link hrefs", () => {
    const html = appendHtmlFooter("<p>Hi</p>", {
      reason: 'Test "quotes"',
      links: [{ label: "Prefs", href: "https://releases.sh/following?x=1" }],
    });
    expect(html).toContain("Test &quot;quotes&quot;");
    expect(html).toContain("https://releases.sh/following?x=1");
    expect(html).toContain("Prefs");
  });
});
