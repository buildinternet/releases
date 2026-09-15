import { describe, expect, it, test } from "bun:test";
import {
  assertPublicWebhookTarget,
  blockedWebhookHostname,
  isPrivateIpv4,
  validateDiscordWebhookUrl,
  validateFormatWebhookUrl,
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

const DISCORD_HOOK =
  "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz";

describe("validateDiscordWebhookUrl", () => {
  test("accepts a discord.com webhook URL", () => {
    expect(validateDiscordWebhookUrl(DISCORD_HOOK)).toBeNull();
  });
  test("accepts the legacy discordapp.com host", () => {
    expect(
      validateDiscordWebhookUrl(
        "https://discordapp.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
      ),
    ).toBeNull();
  });
  test("accepts canary and PTB hosts", () => {
    expect(
      validateDiscordWebhookUrl("https://canary.discord.com/api/webhooks/1/token-._ok"),
    ).toBeNull();
    expect(validateDiscordWebhookUrl("https://ptb.discord.com/api/webhooks/1/token")).toBeNull();
  });
  test("accepts a versioned API path and a trailing slash", () => {
    expect(
      validateDiscordWebhookUrl("https://discord.com/api/v10/webhooks/123456789012345678/token/"),
    ).toBeNull();
  });
  test("accepts query strings such as wait / thread_id", () => {
    expect(validateDiscordWebhookUrl(`${DISCORD_HOOK}?wait=true`)).toBeNull();
  });
  test("rejects a non-Discord host", () => {
    expect(validateDiscordWebhookUrl("https://example.com/api/webhooks/1/token")).toMatch(
      /discord\.com/,
    );
  });
  test("rejects a lookalike host", () => {
    expect(
      validateDiscordWebhookUrl("https://discord.com.evil.com/api/webhooks/1/token"),
    ).not.toBeNull();
  });
  test("rejects a Discord URL that is not a webhook path", () => {
    expect(validateDiscordWebhookUrl("https://discord.com/channels/1/2")).toMatch(
      /\/api\/webhooks/,
    );
  });
  test("rejects Slack-compat and GitHub-compat suffixes", () => {
    expect(validateDiscordWebhookUrl(`${DISCORD_HOOK}/slack`)).toMatch(/\/api\/webhooks/);
    expect(validateDiscordWebhookUrl(`${DISCORD_HOOK}/github`)).toMatch(/\/api\/webhooks/);
  });
});

describe("validateFormatWebhookUrl", () => {
  test("is a no-op for json", () => {
    expect(validateFormatWebhookUrl("json", "https://example.com/hook")).toBeNull();
  });
  test("delegates slack and discord", () => {
    expect(validateFormatWebhookUrl("slack", DISCORD_HOOK)).not.toBeNull();
    expect(
      validateFormatWebhookUrl("discord", "https://hooks.slack.com/services/T/B/X"),
    ).not.toBeNull();
    expect(validateFormatWebhookUrl("discord", DISCORD_HOOK)).toBeNull();
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
