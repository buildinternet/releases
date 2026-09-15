import { describe, expect, test } from "bun:test";
import {
  WEBHOOK_FORMATS,
  isUnsignedWebhookFormat,
  isWebhookFormat,
  parseWebhookFormat,
} from "./schema.js";

describe("webhook format helpers", () => {
  test("WEBHOOK_FORMATS includes json, slack, and discord", () => {
    expect(WEBHOOK_FORMATS).toEqual(["json", "slack", "discord"]);
  });

  test("parseWebhookFormat defaults empty values to json", () => {
    expect(parseWebhookFormat(undefined)).toBe("json");
    expect(parseWebhookFormat(null)).toBe("json");
    expect(parseWebhookFormat("")).toBe("json");
  });

  test("parseWebhookFormat accepts known formats and rejects unknown", () => {
    expect(parseWebhookFormat("discord")).toBe("discord");
    expect(parseWebhookFormat("slack")).toBe("slack");
    expect(parseWebhookFormat("json")).toBe("json");
    expect(parseWebhookFormat("teams")).toBeNull();
  });

  test("isUnsignedWebhookFormat covers slack and discord only", () => {
    expect(isUnsignedWebhookFormat("slack")).toBe(true);
    expect(isUnsignedWebhookFormat("discord")).toBe(true);
    expect(isUnsignedWebhookFormat("json")).toBe(false);
    expect(isWebhookFormat("discord")).toBe(true);
    expect(isWebhookFormat("teams")).toBe(false);
  });
});
