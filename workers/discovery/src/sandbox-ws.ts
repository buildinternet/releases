const clients = new Set<ServerWebSocket<unknown>>();

Bun.serve({
  port: 8081,
  fetch(req, server) {
    if (server.upgrade(req)) return undefined;
    return new Response("WebSocket server for discovery logs", { status: 200 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
    },
    close(ws) {
      clients.delete(ws);
    },
    message(_ws, message) {
      const payload = typeof message === "string" ? message : new TextDecoder().decode(message);
      for (const client of clients) {
        try {
          client.send(payload);
        } catch {
          clients.delete(client);
        }
      }
    },
  },
});

console.log("[sandbox-ws] Listening on port 8081");
