import { describe, it, expect } from "bun:test";
import { writeDeliveryAttempt } from "./ae.js";

function fakeAE() {
  const written: any[] = [];
  return {
    ds: {
      writeDataPoint: (point: any) => {
        written.push(point);
      },
    } as any,
    written,
  };
}

describe("writeDeliveryAttempt", () => {
  it("indexes by subscription_id and includes outcome blob", () => {
    const ae = fakeAE();
    writeDeliveryAttempt(ae.ds, {
      subscriptionId: "whk_1",
      eventId: "evt_x",
      outcome: "success",
      httpStatus: 200,
      latencyMs: 42,
      attempt: 1,
      errorMessage: null,
      errorCode: null,
      format: "json",
      slackApp: "",
    });
    expect(ae.written.length).toBe(1);
    expect(ae.written[0].indexes).toEqual(["whk_1"]);
    expect(ae.written[0].blobs[0]).toBe("evt_x");
    expect(ae.written[0].blobs[3]).toBe("success");
    expect(ae.written[0].doubles).toEqual([200, 42, 1]);
  });

  it("handles error fields without throwing", () => {
    const ae = fakeAE();
    writeDeliveryAttempt(ae.ds, {
      subscriptionId: "whk_1",
      eventId: "evt_x",
      outcome: "perm_fail",
      httpStatus: 400,
      latencyMs: 50,
      attempt: 1,
      errorMessage: "bad payload",
      errorCode: "subscriber_4xx",
      format: "json",
      slackApp: "",
    });
    expect(ae.written[0].blobs[1]).toBe("bad payload");
    expect(ae.written[0].blobs[2]).toBe("subscriber_4xx");
  });

  it("captures format + slack app id as segmentable blobs", () => {
    const ae = fakeAE();
    writeDeliveryAttempt(ae.ds, {
      subscriptionId: "whk_1",
      eventId: "evt_x",
      outcome: "success",
      httpStatus: 200,
      latencyMs: 12,
      attempt: 1,
      errorMessage: null,
      errorCode: null,
      format: "slack",
      slackApp: "T012AB/B034CD",
    });
    expect(ae.written[0].blobs[4]).toBe("slack");
    expect(ae.written[0].blobs[5]).toBe("T012AB/B034CD");
  });
});
