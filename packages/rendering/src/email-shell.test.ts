import { describe, expect, it } from "bun:test";
import { renderEmail, subjectNames, type EmailDoc } from "./email-shell.js";

const base: EmailDoc = {
  lane: "Account · Verify",
  title: "Welcome to Releases",
  blocks: [{ t: "p", text: "Confirm your address." }],
  footer: { reason: "You signed up for Releases." },
};

describe("renderEmail", () => {
  it("renders a complete document with both parts", () => {
    const { html, text } = renderEmail(base);
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("max-width:600px");
    expect(text).toContain("Welcome to Releases");
    expect(text).toContain("Confirm your address.");
  });

  it("never emits a double quote inside a style attribute value", () => {
    // Font stacks are the trap: `font-family:…"Segoe UI"…` closes `style="` early
    // and silently unstyles the rest of the element.
    const { html } = renderEmail(base);
    expect(html).toContain("'Segoe UI'");
    expect(html).not.toContain('"Segoe UI"');
  });

  it("pairs every button with the URL in copyable text, in both parts", () => {
    const url = "https://api.releases.test/verify?token=abc123";
    const { html, text } = renderEmail({
      ...base,
      blocks: [{ t: "button", label: "Verify email", url }],
    });
    expect(html).toContain("Or paste this link into your browser");
    // The URL appears as visible text, not only as an href.
    expect(html).toContain(`>${url}</a>`);
    expect(text).toContain(`Verify email: ${url}`);
  });

  it("always carries the reason and the brand line in the footer", () => {
    const { html, text } = renderEmail({
      ...base,
      footer: {
        reason: "You follow these orgs.",
        links: [{ label: "Unsubscribe", href: "https://api.releases.test/u/1" }],
      },
    });
    expect(html).toContain("You follow these orgs.");
    expect(html).toContain("Open source release notes registry");
    expect(html).toContain("https://api.releases.test/u/1");
    expect(text).toContain("You follow these orgs.");
    expect(text).toContain("Unsubscribe: https://api.releases.test/u/1");
    expect(text).toContain("Open source release notes registry");
  });

  it("carries severity on the top rule", () => {
    expect(renderEmail({ ...base, tone: "crit" }).html).toContain("background:#b4381f;");
    expect(renderEmail({ ...base, tone: "warn" }).html).toContain("background:#b4691f;");
  });

  it("emits a Gmail Go-To annotation for a view action", () => {
    const { html } = renderEmail({
      ...base,
      action: { kind: "view", name: "Verify email", url: "https://releases.test/go" },
    });
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@type":"ViewAction"');
    expect(html).toContain('"target":"https://releases.test/go"');
  });

  it("emits a Gmail One-Click annotation with an HTTP POST handler", () => {
    const { html } = renderEmail({
      ...base,
      action: { kind: "confirm", name: "Verify email", postUrl: "https://api.releases.test/oc" },
    });
    expect(html).toContain('"@type":"ConfirmAction"');
    expect(html).toContain('"@type":"HttpActionHandler"');
    expect(html).toContain('"method":"http://schema.org/HttpRequestMethod/POST"');
  });

  it("escapes a title that could break out of the JSON-LD script tag", () => {
    const { html } = renderEmail({
      ...base,
      preheader: "</script><script>alert(1)</script>",
      action: { kind: "view", name: "Go", url: "https://releases.test/go" },
    });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script");
  });

  it("renders markdown in release content rather than showing its syntax", () => {
    const { html, text } = renderEmail({
      ...base,
      blocks: [
        {
          t: "orgGroup",
          name: "Acme",
          posts: [
            {
              title: "Ship `--dry-run`",
              url: "https://releases.test/r/1",
              summary: "**Fast** now, see [docs](https://x.test/d).",
            },
          ],
        },
      ],
    });
    expect(html).toContain("<code");
    expect(html).toContain("<strong>Fast</strong>");
    expect(html).not.toContain("**Fast**");
    expect(text).toContain("Fast now, see docs.");
    expect(text).not.toContain("**");
  });

  it("aligns data rows in the text part", () => {
    const { text } = renderEmail({
      ...base,
      blocks: [
        {
          t: "data",
          rows: [
            { label: "url", value: "https://x.test" },
            { label: "last error", value: "HTTP 500", kind: "err" },
          ],
        },
      ],
    });
    expect(text).toContain("  url:        https://x.test");
    expect(text).toContain("  last error: HTTP 500");
  });
});

describe("subjectNames", () => {
  it("names one thing outright", () => {
    expect(subjectNames(["Cloudflare"])).toBe("Cloudflare");
  });

  it("names the first two and counts the rest", () => {
    expect(subjectNames(["Cloudflare", "Anthropic", "Vercel", "Stripe"])).toBe(
      "Cloudflare, Anthropic +2 more",
    );
  });

  it("honours a tighter cap for long entity names", () => {
    expect(subjectNames(["Vercel — Next.js", "Acme — changelog"], 1)).toBe(
      "Vercel — Next.js +1 more",
    );
  });

  it("collapses duplicates so one org's burst doesn't read as several", () => {
    expect(subjectNames(["Acme", "Acme", "Acme"])).toBe("Acme");
  });

  it("drops blank and missing names rather than counting them", () => {
    expect(subjectNames([null, "  ", "Acme", undefined])).toBe("Acme");
    expect(subjectNames([null, undefined])).toBe("");
  });
});
