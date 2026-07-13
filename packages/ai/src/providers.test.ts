import { describe, expect, test } from "bun:test";
import { detectProviderFromHtml, getProviderHints } from "./providers.js";

describe("Blume provider detection", () => {
  // The reliable marker is the inline anti-flash theme script Blume emits in
  // <head>, referencing the `blume-theme` localStorage key. Trimmed to the head
  // fragment that detectFromHttpSignals actually sees (it scans <head> only).
  // og:site_name is deliberately a non-"Blume" value: self-hosters override it,
  // so detection must not lean on it.
  const blumeHead =
    '<meta content="Acme Docs" property="og:site_name">' +
    '<script data-mode="system">(()=>{const m=document.currentScript?.dataset.mode??"system";' +
    'const s=localStorage.getItem("blume-theme");})();</script>';

  test("detects Blume from the in-head theme marker, independent of og:site_name", () => {
    const detected = detectProviderFromHtml(blumeHead);
    expect(detected?.id).toBe("blume");
    expect(detected?.name).toBe("Blume");
  });

  test("hints route to the RSS feed at the changelog root", () => {
    const hints = getProviderHints("blume");
    expect(hints?.preferredType).toBe("feed");
    // Absolute /changelog/rss.xml must be listed first so onboarding from the
    // site root resolves the feed even without the autodiscovery <link>.
    expect(hints?.feedPaths?.[0]).toBe("/changelog/rss.xml");
    expect(hints?.changelogPaths).toContain("/changelog");
    expect(hints?.staticContent).toBe(true);
    // markdownSuffix is intentionally omitted (index .md 404s).
    expect(hints?.markdownSuffix).toBeUndefined();
  });

  test("body-only markers in <head>-less input do not misfire on unrelated sites", () => {
    expect(detectProviderFromHtml("<meta charset=utf-8><title>Some Blog</title>")).toBeNull();
  });
});
