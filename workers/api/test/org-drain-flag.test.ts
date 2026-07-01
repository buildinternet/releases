import { describe, it, expect } from "bun:test";
import { FLAGS, flag } from "@releases/lib/flags";

describe("orgDrainActorEnabled flag", () => {
  it("is registered with the right key/env/default", () => {
    expect(FLAGS.orgDrainActorEnabled).toEqual({
      key: "org-drain-actor-enabled",
      env: "ORG_DRAIN_ACTOR_ENABLED",
      default: false,
    });
  });

  it("defaults off with no binding and no var", async () => {
    expect(await flag(undefined, undefined, FLAGS.orgDrainActorEnabled)).toBe(false);
  });

  it("reads the wrangler var fallback when set", async () => {
    expect(await flag(undefined, "true", FLAGS.orgDrainActorEnabled)).toBe(true);
  });
});
