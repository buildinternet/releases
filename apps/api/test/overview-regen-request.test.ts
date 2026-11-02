/**
 * POST /v1/workflows/overview-regen must not treat `{}` as "every org".
 * The daily cron does not use this parser.
 */
import { describe, expect, it } from "bun:test";
import { parseOverviewRegenBody } from "../src/lib/overview-regen-request.js";

describe("parseOverviewRegenBody", () => {
  it("requires an explicit org list or all:true", () => {
    expect(parseOverviewRegenBody({}).ok).toBe(false);
    expect(parseOverviewRegenBody({ orgs: [] }).ok).toBe(false);
    expect(parseOverviewRegenBody({ orgs: "datadog" }).ok).toBe(false);
    expect(parseOverviewRegenBody({ force: true }).ok).toBe(false);
    expect(parseOverviewRegenBody({ force: true, all: true }).ok).toBe(false);

    expect(parseOverviewRegenBody({ all: true })).toEqual({
      ok: true,
      value: { orgs: undefined, dryRun: false, maxOrgs: undefined, force: false },
    });
    expect(parseOverviewRegenBody({ orgs: [" Datadog "] })).toMatchObject({
      ok: true,
      value: { orgs: ["Datadog"], force: false },
    });
    expect(parseOverviewRegenBody({ orgs: ["datadog"], force: true, dryRun: true })).toMatchObject({
      ok: true,
      value: { orgs: ["datadog"], force: true, dryRun: true },
    });
  });
});
