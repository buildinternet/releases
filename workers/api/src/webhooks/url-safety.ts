/**
 * Re-export of the shared SSRF gates. Implementation lives in
 * `@releases/core-internal/webhook-url-safety` so the webhooks delivery
 * worker can import the same module without a cross-worker relative path.
 */
export {
  assertPublicWebhookTarget,
  blockedWebhookHostname,
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateOrReservedIp,
  resolveHostAddresses,
  validateSlackWebhookUrl,
  validateWebhookUrl,
  type DnsLookup,
} from "@releases/core-internal/webhook-url-safety";
