import { describe, expect, it, mock } from "bun:test";
import {
  buildReleaseFanoutMessage,
  enqueueReleaseFanout,
  fanoutWebhooks,
} from "../src/queues/enqueue-release-fanout.js";
import { processReleaseFanoutMessage } from "../src/queues/release-fanout-consumer.js";
import type { ReleaseEvent } from "../src/events/types.js";

const event: ReleaseEvent = {
  id: "evt_1",
  seq: 0,
  ts: 1,
  type: "release.created",
  release: { id: "rel_1" } as ReleaseEvent["release"],
};

describe("buildReleaseFanoutMessage", () => {
  it("serializes owners for queue transport", () => {
    const msg = buildReleaseFanoutMessage(
      [event],
      new Map([
        [
          "rel_1",
          {
            orgId: "org_a",
            sourceId: "src_a",
            productId: null,
            releaseType: "feature" as const,
          },
        ],
      ]),
    );
    expect(msg.events).toHaveLength(1);
    expect(msg.owners).toEqual([
      {
        releaseId: "rel_1",
        orgId: "org_a",
        sourceId: "src_a",
        productId: null,
        releaseType: "feature",
      },
    ]);
  });
});

describe("enqueueReleaseFanout", () => {
  it("never throws on queue failure", async () => {
    await enqueueReleaseFanout({
      events: [event],
      eventOwners: new Map([
        [
          "rel_1",
          {
            orgId: "org_a",
            sourceId: "src_a",
            productId: null,
            releaseType: "feature",
          },
        ],
      ]),
      queue: {
        send: mock(async () => {
          throw new Error("down");
        }),
      },
    });
  });
});

describe("fanoutWebhooks", () => {
  it("uses release-events queue when bound", async () => {
    const send = mock(async () => undefined);
    await fanoutWebhooks(
      { DB: {} as D1Database },
      [event],
      new Map([
        [
          "rel_1",
          {
            orgId: "org_a",
            sourceId: "src_a",
            productId: null,
            releaseType: "feature",
          },
        ],
      ]),
      { send },
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("no-ops without queue or delivery binding", async () => {
    await fanoutWebhooks({} as any, [event], new Map());
  });
});

describe("processReleaseFanoutMessage", () => {
  it("throws when delivery queue is missing (for retry)", async () => {
    await expect(
      processReleaseFanoutMessage(
        { DB: {} as D1Database },
        buildReleaseFanoutMessage([event], new Map()),
      ),
    ).rejects.toThrow("WEBHOOK_DELIVERY_QUEUE");
  });
});
