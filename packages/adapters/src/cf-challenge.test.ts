import { describe, it, expect } from "bun:test";
import { isCloudflareChallengePage } from "./cf-challenge.js";

// Representative renders of a Cloudflare Managed Challenge interstitial as it
// reaches us through Browser Rendering's /markdown converter. We never see the
// real article — only the challenge page — so detection keys off the markers
// that survive HTML→markdown (visible interstitial copy) plus the source-level
// challenge-platform markers in case any survive the conversion.

describe("isCloudflareChallengePage", () => {
  it("detects the JS-disabled managed-challenge interstitial copy", () => {
    const md = "help.openai.com\n\nEnable JavaScript and cookies to continue";
    expect(isCloudflareChallengePage(md)).toBe(true);
  });

  it("detects the JS-enabled 'verifying you are human' interstitial", () => {
    const md =
      "# Just a moment...\n\nVerifying you are human. This may take a few seconds.\n\nPerformance & security by Cloudflare";
    expect(isCloudflareChallengePage(md)).toBe(true);
  });

  it("detects the legacy 'checking your browser' challenge", () => {
    const md = "Checking your browser before accessing help.openai.com.";
    expect(isCloudflareChallengePage(md)).toBe(true);
  });

  it("detects the 'review the security of your connection' interstitial", () => {
    const md = "help.openai.com needs to review the security of your connection before proceeding.";
    expect(isCloudflareChallengePage(md)).toBe(true);
  });

  it("detects the inline challenge-platform script marker", () => {
    const md = "<script>window._cf_chl_opt={cvId:'3',cType:'managed'}</script>";
    expect(isCloudflareChallengePage(md)).toBe(true);
  });

  it("detects the cdn-cgi/challenge-platform loader path", () => {
    const md = "/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=abc";
    expect(isCloudflareChallengePage(md)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isCloudflareChallengePage("VERIFYING YOU ARE HUMAN")).toBe(true);
  });

  it("returns false for a real changelog body", () => {
    const md =
      "# ChatGPT release notes\n\n## March 3, 2026\n\nWe shipped a new model picker and improved voice mode. Enjoy!";
    expect(isCloudflareChallengePage(md)).toBe(false);
  });

  it("does not false-positive on content that merely names Cloudflare", () => {
    const md =
      "## January 2026\n\nWe migrated our CDN to Cloudflare and reduced p95 latency. See the Ray ID in response headers for tracing.";
    expect(isCloudflareChallengePage(md)).toBe(false);
  });

  it("returns false for empty or whitespace content", () => {
    expect(isCloudflareChallengePage("")).toBe(false);
    expect(isCloudflareChallengePage("   \n  ")).toBe(false);
  });
});
