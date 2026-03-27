import { DurableObject } from "cloudflare:workers";

const STALE_SESSION_MS = 15 * 60 * 1000; // 15 minutes with no update → mark as error

interface SessionState {
  sessionId: string;
  company: string;
  status: "running" | "complete" | "error";
  step?: string;
  sourcesFound?: number;
  sourcesValidated?: number;
  currentAction?: string;
  startedAt: number;
  lastUpdatedAt: number;
  error?: string;
}

interface StatusMessage {
  type:
    | "session:start"
    | "session:progress"
    | "session:complete"
    | "session:error"
    | "fetch:complete"
    | "init";
  [key: string]: unknown;
}

export class StatusHub extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // HTTP endpoint: push an event from internal producers
    if (request.method === "POST" && url.pathname === "/event") {
      const event = (await request.json()) as StatusMessage;
      await this.handleEvent(event);
      return new Response("ok", { status: 200 });
    }

    // WebSocket upgrade for browser clients
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const sessions = await this.getSessions();
      pair[1].send(JSON.stringify({ type: "init", sessions }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // HTTP endpoint: get current sessions (for page hydration)
    if (request.method === "GET" && url.pathname === "/sessions") {
      const sessions = await this.getSessions();
      return new Response(JSON.stringify(sessions), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}
  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {}
  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {}

  private async handleEvent(event: StatusMessage): Promise<void> {
    const now = Date.now();
    if (event.type === "session:start") {
      const session: SessionState = {
        sessionId: event.sessionId as string,
        company: event.company as string,
        status: "running",
        startedAt: now,
        lastUpdatedAt: now,
      };
      await this.ctx.storage.put(`session:${session.sessionId}`, session);
    } else if (event.type === "session:progress") {
      const existing = await this.ctx.storage.get<SessionState>(`session:${event.sessionId}`);
      if (existing) {
        existing.step = event.step as string;
        existing.sourcesFound = event.sourcesFound as number;
        existing.sourcesValidated = event.sourcesValidated as number;
        existing.currentAction = event.currentAction as string;
        existing.lastUpdatedAt = now;
        await this.ctx.storage.put(`session:${existing.sessionId}`, existing);
      }
    } else if (event.type === "session:complete") {
      const existing = await this.ctx.storage.get<SessionState>(`session:${event.sessionId}`);
      if (existing) {
        existing.status = "complete";
        existing.lastUpdatedAt = now;
        await this.ctx.storage.put(`session:${existing.sessionId}`, existing);
      }
    } else if (event.type === "session:error") {
      const existing = await this.ctx.storage.get<SessionState>(`session:${event.sessionId}`);
      if (existing) {
        existing.status = "error";
        existing.error = event.error as string;
        existing.lastUpdatedAt = now;
        await this.ctx.storage.put(`session:${existing.sessionId}`, existing);
      }
    }
    this.broadcast(event);
  }

  private broadcast(message: StatusMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch { /* disconnected */ }
    }
  }

  private async getSessions(): Promise<SessionState[]> {
    const entries = await this.ctx.storage.list<SessionState>({ prefix: "session:" });
    const now = Date.now();
    const sessions: SessionState[] = [];

    for (const session of entries.values()) {
      // Auto-expire stale running sessions
      const lastUpdate = session.lastUpdatedAt || session.startedAt;
      if (session.status === "running" && now - lastUpdate > STALE_SESSION_MS) {
        session.status = "error";
        session.error = "Session timed out (no updates received)";
        session.lastUpdatedAt = now;
        await this.ctx.storage.put(`session:${session.sessionId}`, session);
      }
      sessions.push(session);
    }

    sessions.sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return b.startedAt - a.startedAt;
    });
    return sessions;
  }
}
