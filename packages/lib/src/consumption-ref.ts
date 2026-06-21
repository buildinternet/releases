import { hashSecret } from "@buildinternet/releases-core/api-token";

/** Stable identity input for a PII-clean consumption `consumerRef` (#1719). */
export type ConsumptionRefIdentity =
  | { kind: "root" }
  | { kind: "anonymous" }
  | { kind: "token"; tokenId: string };

/**
 * Non-reversible per-principal bucket for consumption telemetry (#1719).
 * Hashes a stable internal id (`relk_` row id, `relu_${keyId}`, `oauth_${sub}`),
 * never a raw token, email, or IP. `root` / `anonymous` are fixed labels.
 */
export async function consumptionConsumerRef(identity: ConsumptionRefIdentity): Promise<string> {
  if (identity.kind === "root") return "root";
  if (identity.kind === "anonymous") return "anonymous";
  return hashSecret(`consumption:${identity.tokenId}`);
}
