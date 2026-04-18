import { getReleaseHub } from "../utils.js";
import { buildReleaseEventPayloads, type InsertedReleaseRow } from "./build-event.js";

export interface PublishContext {
  src: { name: string; slug: string };
  inserted: InsertedReleaseRow[];
}

/**
 * Publish release.created events to the ReleaseHub DO. Fire-and-forget —
 * callers wrap this in `ctx.waitUntil()` after the D1 write. Hub failures
 * are logged but never thrown, so ingestion never fails on publish errors.
 *
 * No-op when `inserted` is empty.
 */
export async function publishReleaseEvents(
  env: { RELEASE_HUB: DurableObjectNamespace },
  ctx: PublishContext,
): Promise<void> {
  if (ctx.inserted.length === 0) return;
  const events = buildReleaseEventPayloads(ctx);
  try {
    const res = await getReleaseHub(env).fetch(new Request("https://do/publish", {
      method: "POST",
      body: JSON.stringify({ events }),
      headers: { "Content-Type": "application/json" },
    }));
    if (!res.ok) {
      console.warn(`[events] publish returned ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } catch (err) {
    console.warn(
      `[events] publish failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
