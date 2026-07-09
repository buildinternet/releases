/**
 * Register platform-handled WebSocket ping/pong so idle clients don't wake the DO.
 * Call once per upgrade, before acceptWebSocket.
 */
export function enableWsPingPong(ctx: DurableObjectState): void {
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
}
