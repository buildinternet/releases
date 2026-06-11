import { test, expect } from "bun:test";
import { wordMatch, domainLabelMatch, urlMatch, rankEntityCandidate } from "./entity-match.js";

// Cases mirror the live noise audit that motivated word-boundary matching
// (search "ai" surfaced CodeRabbit via coderabbit.ai and React Email via
// "Em·ai·l") so a regression here means the noise is back.

// ── wordMatch ─────────────────────────────────────────────────────────

test("wordMatch: exact name match (case-insensitive)", () => {
  expect(wordMatch("OpenAI", "openai")).toBe("exact");
  expect(wordMatch("Anthropic", "Anthropic")).toBe("exact");
});

test("wordMatch: prefix of the whole string", () => {
  expect(wordMatch("Tailwind CSS", "tailwind")).toBe("prefix");
  expect(wordMatch("AI SDK", "ai")).toBe("prefix");
});

test("wordMatch: word-boundary hit inside the string", () => {
  expect(wordMatch("Moonshot AI", "ai")).toBe("word");
  expect(wordMatch("Claude Code", "code")).toBe("word");
  expect(wordMatch("prettier-plugin-tailwind", "tailwind")).toBe("word");
});

test("wordMatch: camelCase transitions count as word boundaries", () => {
  expect(wordMatch("OpenAI", "ai")).toBe("word");
  expect(wordMatch("xAI", "ai")).toBe("word");
  expect(wordMatch("CodeRabbit", "rabbit")).toBe("word");
  expect(wordMatch("OpenRouter", "router")).toBe("word");
});

test("wordMatch: mid-word substrings do NOT match", () => {
  expect(wordMatch("React Email", "ai")).toBeNull(); // Em·ai·l
  expect(wordMatch("Superhuman Mail", "ai")).toBeNull(); // M·ai·l
  expect(wordMatch("LangChain", "ai")).toBeNull(); // Ch·ai·n
  expect(wordMatch("Granola", "ola")).toBeNull();
  expect(wordMatch("Anthropic", "hropic")).toBeNull();
});

test("wordMatch: multi-word queries match as a contiguous boundary-anchored phrase", () => {
  expect(wordMatch("Dark Mode Toolkit", "dark mode")).toBe("prefix");
  expect(wordMatch("The Dark Mode Toolkit", "dark mode")).toBe("word");
  expect(wordMatch("Sidekick Mode", "dark mode")).toBeNull();
});

test("wordMatch: null/empty inputs never match", () => {
  expect(wordMatch(null, "ai")).toBeNull();
  expect(wordMatch(undefined, "ai")).toBeNull();
  expect(wordMatch("", "ai")).toBeNull();
  expect(wordMatch("OpenAI", "")).toBeNull();
  expect(wordMatch("OpenAI", "   ")).toBeNull();
});

// ── domainLabelMatch ──────────────────────────────────────────────────

test("domainLabelMatch: TLD never matches — the original .ai noise", () => {
  expect(domainLabelMatch("coderabbit.ai", "ai")).toBe(false);
  expect(domainLabelMatch("granola.ai", "ai")).toBe(false);
  expect(domainLabelMatch("fin.ai", "ai")).toBe(false);
  expect(domainLabelMatch("claude.ai", "ai")).toBe(false);
});

test("domainLabelMatch: label prefix matches", () => {
  expect(domainLabelMatch("tailwindcss.com", "tailwind")).toBe(true);
  expect(domainLabelMatch("coderabbit.ai", "coderabbit")).toBe(true);
  expect(domainLabelMatch("coderabbit.ai", "code")).toBe(true);
  expect(domainLabelMatch("new.superhuman.com", "superhuman")).toBe(true);
});

test("domainLabelMatch: non-TLD label substring does not match mid-label", () => {
  expect(domainLabelMatch("openai.com", "ai")).toBe(false);
});

test("domainLabelMatch: dotted query matches the host exactly or as a parent domain", () => {
  expect(domainLabelMatch("vercel.com", "vercel.com")).toBe(true);
  expect(domainLabelMatch("docs.vercel.com", "vercel.com")).toBe(true);
  expect(domainLabelMatch("notvercel.com", "vercel.com")).toBe(false);
});

test("domainLabelMatch: null/empty inputs never match", () => {
  expect(domainLabelMatch(null, "ai")).toBe(false);
  expect(domainLabelMatch("vercel.com", "")).toBe(false);
});

// ── urlMatch ──────────────────────────────────────────────────────────

test("urlMatch: host TLD never matches", () => {
  expect(urlMatch("https://openrouter.ai/changelog", "ai")).toBe(false);
  expect(urlMatch("https://coderabbit.ai/", "ai")).toBe(false);
});

test("urlMatch: host label and path segments match at boundaries", () => {
  expect(urlMatch("https://openrouter.ai/changelog", "openrouter")).toBe(true);
  expect(urlMatch("https://github.com/openai/whisper", "whisper")).toBe(true);
  expect(urlMatch("https://example.com/release-notes", "notes")).toBe(true);
});

test("urlMatch: mid-segment substrings do not match", () => {
  expect(urlMatch("https://github.com/openai/whisper", "ai")).toBe(false);
  expect(urlMatch("https://example.com/mainline", "ai")).toBe(false);
});

test("urlMatch: slash queries match multi-segment paths at boundaries", () => {
  // Coordinate-shaped queries ("org/repo") must keep matching indexed GitHub
  // sources so the on-demand lookup stays suppressed for known repos.
  expect(urlMatch("https://github.com/acme/existingrepo", "acme/existingrepo")).toBe(true);
  expect(urlMatch("https://github.com/acme/existingrepo", "cme/existingrepo")).toBe(false);
  expect(urlMatch("https://github.com/acme/other", "acme/existingrepo")).toBe(false);
});

test("urlMatch: tolerates scheme-less and unparseable input", () => {
  expect(urlMatch("github.com/vercel/next.js", "vercel")).toBe(true);
  expect(urlMatch("not a url at all", "ai")).toBe(false);
  expect(urlMatch(null, "ai")).toBe(false);
});

// ── rankEntityCandidate ───────────────────────────────────────────────

test("rankEntityCandidate: exact name or slug is the top tier", () => {
  expect(rankEntityCandidate({ name: "OpenAI" }, "openai")).toBe(0);
  expect(rankEntityCandidate({ name: "Tailwind CSS", slug: "tailwind" }, "tailwind")).toBe(0);
});

test("rankEntityCandidate: name prefix beats name word beats slug/domain", () => {
  const prefix = rankEntityCandidate({ name: "Tailwind CSS" }, "tailwind");
  const word = rankEntityCandidate({ name: "Moonshot AI" }, "ai");
  const domain = rankEntityCandidate(
    { name: "Resend", domains: ["resend.com", "react.email"] },
    "react",
  );
  expect(prefix).toBeLessThan(word!);
  expect(word).toBeLessThan(domain!);
});

test("rankEntityCandidate: category matches rank last", () => {
  const name = rankEntityCandidate({ name: "Moonshot AI" }, "ai");
  const category = rankEntityCandidate({ name: "Anthropic", categories: ["AI"] }, "ai");
  expect(category).toBeGreaterThan(name!);
  expect(category).not.toBeNull();
});

test("rankEntityCandidate: substring-only candidates are rejected", () => {
  // The live noise set: all matched LIKE %ai% but none deserve a hit.
  expect(rankEntityCandidate({ name: "React Email", slug: "react-email" }, "ai")).toBeNull();
  expect(
    rankEntityCandidate(
      { name: "CodeRabbit", slug: "coderabbit", domains: ["coderabbit.ai"] },
      "ai",
    ),
  ).toBeNull();
  expect(
    rankEntityCandidate(
      { name: "Granola", domains: ["granola.ai"], categories: ["Productivity"] },
      "ai",
    ),
  ).toBeNull();
  expect(
    rankEntityCandidate({ name: "Changelog", urls: ["https://openrouter.ai/changelog"] }, "ai"),
  ).toBeNull();
});

test("rankEntityCandidate: urls rank with slug/domain tier", () => {
  const viaUrl = rankEntityCandidate(
    { name: "Changelog", urls: ["https://github.com/openai/whisper"] },
    "whisper",
  );
  const viaDomain = rankEntityCandidate({ name: "Resend", domains: ["react.email"] }, "react");
  expect(viaUrl).toBe(viaDomain!);
});
