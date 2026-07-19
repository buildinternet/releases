import { describe, expect, it, test } from "bun:test";
import {
  assertPublicWebhookTarget,
  blockedWebhookHostname,
  isPrivateIpv4,
  validateSlackWebhookUrl,
  validateWebhookUrl,
} from "./webhook-url-safety.js";

const PUBLIC_HOOK = "https://1.1.1.1/hook";

describe("validateWebhookUrl", () => {
  it("accepts HTTPS public literal IPs", () => {
    expect(validateWebhookUrl(PUBLIC_HOOK)).toBeNull();
  });

  it("rejects non-HTTPS", () => {
    expect(validateWebhookUrl("http://1.1.1.1/hook")).toBe("url must use HTTPS");
  });

  it("rejects localhost", () => {
    expect(validateWebhookUrl("https://localhost/hook")).toBe(
      "url must not target localhost, link-local, or metadata addresses",
    );
  });

  it("rejects private IPv4 literals", () => {
    expect(validateWebhookUrl("https://192.168.1.1/hook")).toBe(
      "url must not target a private or reserved address",
    );
  });

  it("rejects metadata address", () => {
    expect(validateWebhookUrl("https://169.254.169.254/latest/meta-data")).toBe(
      "url must not target localhost, link-local, or metadata addresses",
    );
  });
});

describe("blockedWebhookHostname", () => {
  it("rejects .internal suffix", () => {
    expect(blockedWebhookHostname("foo.internal")).toBe(
      "url must not target private or internal hostnames",
    );
  });
});

describe("isPrivateIpv4", () => {
  it("classifies RFC1918 ranges", () => {
    expect(isPrivateIpv4([10, 0, 0, 1])).toBe(true);
    expect(isPrivateIpv4([8, 8, 8, 8])).toBe(false);
  });
});

describe("validateSlackWebhookUrl", () => {
  test("accepts a hooks.slack.com URL", () => {
    expect(validateSlackWebhookUrl("https://hooks.slack.com/services/T/B/X")).toBeNull();
  });
  test("accepts a GovSlack hooks host", () => {
    expect(validateSlackWebhookUrl("https://hooks.slack-gov.com/services/T/B/X")).toBeNull();
  });
  test("rejects a non-Slack host", () => {
    expect(validateSlackWebhookUrl("https://example.com/hook")).toMatch(/hooks\.slack\.com/);
  });
  test("rejects a lookalike host", () => {
    expect(validateSlackWebhookUrl("https://hooks.slack.com.evil.com/x")).not.toBeNull();
  });
});

describe("assertPublicWebhookTarget", () => {
  it("skips DNS for public literal IPs", async () => {
    expect(await assertPublicWebhookTarget(PUBLIC_HOOK)).toBeNull();
  });

  it("rejects hostnames that resolve to private addresses", async () => {
    const err = await assertPublicWebhookTarget("https://evil.example/hook", {
      resolveDns: async () => ["127.0.0.1"],
    });
    expect(err).toBe("url must not resolve to a private or reserved address");
  });

  it("rejects hostnames with no DNS answers", async () => {
    const err = await assertPublicWebhookTarget("https://nope.example/hook", {
      resolveDns: async () => [],
    });
    expect(err).toBe("url hostname could not be resolved");
  });

  it("accepts hostnames that resolve only to public addresses", async () => {
    const err = await assertPublicWebhookTarget("https://hooks.example/hook", {
      resolveDns: async () => ["1.1.1.1", "2606:4700:4700::1111"],
    });
    expect(err).toBeNull();
  });
});
