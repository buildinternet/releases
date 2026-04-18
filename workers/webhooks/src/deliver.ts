import { deriveSigningKey, signPayload } from "@buildinternet/releases-core/webhook-sign";
import type { DeliveryMessage } from "../../api/src/webhooks/types.js";
import type { Outcome } from "./ae.js";

export interface DeliveryResult {
  outcome: Extract<Outcome, "success" | "retry" | "perm_fail">;
  httpStatus: number;       // 0 if no response (network/timeout)
  latencyMs: number;
  errorMessage: string | null;
  errorCode: string | null; // "network", "timeout", "subscriber_5xx", "subscriber_4xx", or null on success
}

export interface DeliverOptions {
  masterKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number; // unix seconds
}

export async function deliver(message: DeliveryMessage, opts: DeliverOptions): Promise<DeliveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const ts = now();
  const body = JSON.stringify(message.event);
  const signingKey = await deriveSigningKey(opts.masterKey, message.subscriptionId, message.secretVersion);
  const signature = await signPayload(signingKey, ts, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  const start = Date.now();

  const request = new Request(message.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Released-Version": "1",
      "X-Released-Event-Id": message.event.id,
      "X-Released-Timestamp": String(ts),
      "X-Released-Signature": signature,
      "User-Agent": "releases-webhooks/1",
    },
    body,
    signal: controller.signal,
  });

  try {
    const res = await fetchImpl(request);
    const latencyMs = Date.now() - start;
    if (res.status >= 200 && res.status < 300) {
      return { outcome: "success", httpStatus: res.status, latencyMs, errorMessage: null, errorCode: null };
    }
    if (res.status >= 400 && res.status < 500) {
      const excerpt = await res.text().then((t) => t.slice(0, 200)).catch(() => "");
      return { outcome: "perm_fail", httpStatus: res.status, latencyMs, errorMessage: excerpt, errorCode: "subscriber_4xx" };
    }
    return { outcome: "retry", httpStatus: res.status, latencyMs, errorMessage: `subscriber returned ${res.status}`, errorCode: "subscriber_5xx" };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    if (err?.name === "AbortError") {
      return { outcome: "retry", httpStatus: 0, latencyMs, errorMessage: "timeout", errorCode: "timeout" };
    }
    return { outcome: "retry", httpStatus: 0, latencyMs, errorMessage: err?.message ?? String(err), errorCode: "network" };
  } finally {
    clearTimeout(timeout);
  }
}
