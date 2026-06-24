import { deriveSigningKey, signPayload } from "@releases/core-internal/webhook-sign";
import { formatSlackMessage } from "@releases/rendering/slack-message";
import type { DeliveryMessage } from "../../api/src/webhooks/types.js";
import type { ErrorCode, Outcome } from "./ae.js";

export interface DeliveryResult {
  outcome: Extract<Outcome, "success" | "retry" | "perm_fail">;
  httpStatus: number; // 0 if no response (network/timeout)
  latencyMs: number;
  errorMessage: string | null;
  errorCode: ErrorCode | null;
}

export interface DeliverOptions {
  masterKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Returns current time as unix seconds. Used for HMAC timestamp + header. */
  now?: () => number;
}

const WEBHOOK_VERSION = "1";
// AE blob budget — keep error bodies short.
const BODY_EXCERPT_BYTES = 200;

export async function deliver(
  message: DeliveryMessage,
  opts: DeliverOptions,
): Promise<DeliveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  let request: Request;
  if (message.format === "slack") {
    // Slack incoming webhooks take a Block Kit body and ignore/forbid our
    // signature headers — the URL is the secret, so we send unsigned.
    const body = JSON.stringify(formatSlackMessage(message.event.release));
    request = new Request(message.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `releases-webhooks/${WEBHOOK_VERSION}`,
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } else {
    const ts = now();
    const body = JSON.stringify(message.event);
    const signingKey = await deriveSigningKey(
      opts.masterKey,
      message.subscriptionId,
      message.secretVersion,
    );
    const signature = await signPayload(signingKey, ts, body);
    request = new Request(message.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Releases-Version": WEBHOOK_VERSION,
        "X-Releases-Event-Id": message.event.id,
        "X-Releases-Timestamp": String(ts),
        "X-Releases-Signature": signature,
        "User-Agent": `releases-webhooks/${WEBHOOK_VERSION}`,
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  }

  const start = Date.now();
  try {
    const res = await fetchImpl(request);
    const latencyMs = Date.now() - start;
    if (res.status >= 200 && res.status < 300) {
      return {
        outcome: "success",
        httpStatus: res.status,
        latencyMs,
        errorMessage: null,
        errorCode: null,
      };
    }
    if (res.status >= 400 && res.status < 500) {
      const excerpt = await res
        .text()
        .then((t) => t.slice(0, BODY_EXCERPT_BYTES))
        .catch(() => "");
      return {
        outcome: "perm_fail",
        httpStatus: res.status,
        latencyMs,
        errorMessage: excerpt,
        errorCode: "subscriber_4xx",
      };
    }
    return {
      outcome: "retry",
      httpStatus: res.status,
      latencyMs,
      errorMessage: `subscriber returned ${res.status}`,
      errorCode: "subscriber_5xx",
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    // AbortSignal.timeout() throws TimeoutError; guard against legacy AbortError too.
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return {
        outcome: "retry",
        httpStatus: 0,
        latencyMs,
        errorMessage: "timeout",
        errorCode: "timeout",
      };
    }
    return {
      outcome: "retry",
      httpStatus: 0,
      latencyMs,
      errorMessage: err?.message ?? String(err),
      errorCode: "network",
    };
  }
}
