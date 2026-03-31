import { DurableObject } from "cloudflare:workers";

const STALE_SESSION_MS = 15 * 60 * 1000; // 15 minutes with no update → mark as error
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // run cleanup daily

interface SessionState {
  sessionId: string;
  company: string;
  type: "onboard" | "update";
  status: "running" | "complete" | "error" | "cancelled";
  step?: string;
  sourcesFound?: number;
  sourcesValidated?: number;
  totalSources?: number;
  sourcesFetched?: number;
  releasesFound?: number;
  releasesInserted?: number;
  currentAction?: string;
  startedAt: number;
  lastUpdatedAt: number;
  error?: string;
  dismissed?: boolean;
  activeSources?: string[];
  cancelRequested?: boolean;
}

interface StatusMessage {
  type:
    | "session:start"
    | "session:progress"
    | "session:complete"
    | "session:error"
    | "session:cancelled"
    | "session:dismissed"
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
      // Piggyback cancelRequested on the response so the CLI doesn't need a separate poll
      let cancelRequested = false;
      const sid = event.sessionId as string | undefined;
      if (sid) {
        const session = await this.ctx.storage.get<SessionState>(`session:${sid}`);
        cancelRequested = session?.cancelRequested === true;
      }
      return new Response(JSON.stringify({ cancelRequested }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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

    // HTTP endpoint: get logs for a session
    const logsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/logs$/);
    if (request.method === "GET" && logsMatch) {
      const sessionId = logsMatch[1];
      const logs = (await this.ctx.storage.get<string[]>(`logs:${sessionId}`)) ?? [];
      return new Response(JSON.stringify(logs), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // HTTP endpoint: cancel a running session
    const cancelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const sessionId = cancelMatch[1];
      const existing = await this.ctx.storage.get<SessionState>(`session:${sessionId}`);
      if (!existing) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (existing.status !== "running") {
        return new Response(JSON.stringify({ error: "not_running", status: existing.status }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      existing.cancelRequested = true;
      await this.ctx.storage.put(`session:${sessionId}`, existing);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // HTTP endpoint: get active source slugs across all running sessions
    if (request.method === "GET" && url.pathname === "/active-sources") {
      const entries = await this.ctx.storage.list<SessionState>({ prefix: "session:" });
      const now = Date.now();
      const slugs = new Set<string>();
      const sessionMap: Record<string, string> = {};
      for (const session of entries.values()) {
        const lastUpdate = session.lastUpdatedAt || session.startedAt;
        if (session.status === "running" && now - lastUpdate <= STALE_SESSION_MS) {
          for (const slug of session.activeSources ?? []) {
            slugs.add(slug);
            sessionMap[slug] = session.sessionId;
          }
        }
      }
      return new Response(JSON.stringify({ slugs: [...slugs], sessionMap }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // HTTP endpoint: get a single session
    const singleMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (request.method === "GET" && singleMatch) {
      const sessionId = singleMatch[1];
      const session = await this.ctx.storage.get<SessionState>(`session:${sessionId}`);
      if (!session) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(session), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // HTTP endpoint: dismiss a terminal session (hides from UI, retains data)
    const dismissMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (request.method === "DELETE" && dismissMatch) {
      const sessionId = dismissMatch[1];
      const existing = await this.ctx.storage.get<SessionState>(`session:${sessionId}`);
      if (existing) {
        existing.dismissed = true;
        await this.ctx.storage.put(`session:${sessionId}`, existing);
      }
      this.broadcast({ type: "session:dismissed", sessionId });
      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}
  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {}
  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {}

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<SessionState>({ prefix: "session:" });
    const keysToDelete: string[] = [];
    for (const [key, session] of entries) {
      const age = now - (session.lastUpdatedAt || session.startedAt);
      if (age > RETENTION_MS && session.status !== "running") {
        keysToDelete.push(key, `logs:${session.sessionId}`);
      }
    }
    if (keysToDelete.length > 0) {
      await this.ctx.storage.delete(keysToDelete);
    }
    // Schedule next cleanup
    await this.ctx.storage.setAlarm(now + CLEANUP_INTERVAL_MS);
  }

  private async handleEvent(event: StatusMessage): Promise<void> {
    const now = Date.now();
    if (event.type === "session:start") {
      const session: SessionState = {
        sessionId: event.sessionId as string,
        company: event.company as string,
        type: (event.sessionType as SessionState["type"]) ?? "onboard",
        status: "running",
        startedAt: now,
        lastUpdatedAt: now,
        activeSources: (event.activeSources as string[]) ?? [],
      };
      await this.ctx.storage.put(`session:${session.sessionId}`, session);
      // Ensure cleanup alarm is scheduled
      const existingAlarm = await this.ctx.storage.getAlarm();
      if (!existingAlarm) {
        await this.ctx.storage.setAlarm(now + CLEANUP_INTERVAL_MS);
      }
    } else if (event.type === "session:progress") {
      const existing = await this.ctx.storage.get<SessionState>(`session:${event.sessionId}`);
      if (existing) {
        if (event.step !== undefined) existing.step = event.step as string;
        if (event.sourcesFound !== undefined) existing.sourcesFound = event.sourcesFound as number;
        if (event.sourcesValidated !== undefined) existing.sourcesValidated = event.sourcesValidated as number;
        if (event.currentAction !== undefined) existing.currentAction = event.currentAction as string;
        if (event.totalSources !== undefined) existing.totalSources = event.totalSources as number;
        if (event.sourcesFetched !== undefined) existing.sourcesFetched = event.sourcesFetched as number;
        if (event.releasesFound !== undefined) existing.releasesFound = event.releasesFound as number;
        if (event.releasesInserted !== undefined) existing.releasesInserted = event.releasesInserted as number;
        if (event.activeSources !== undefined) existing.activeSources = event.activeSources as string[];
        existing.lastUpdatedAt = now;
        await this.ctx.storage.put(`session:${existing.sessionId}`, existing);
      }
      // Persist log lines
      const line = (event.logLine ?? event.currentAction) as string | undefined;
      if (line) {
        const sid = event.sessionId as string;
        const logs = (await this.ctx.storage.get<string[]>(`logs:${sid}`)) ?? [];
        const timestamp = new Date(now).toISOString().slice(11, 19);
        logs.push(`${timestamp}  ${line}`);
        // Keep last 500 lines per session
        const trimmed = logs.length > 500 ? logs.slice(-500) : logs;
        await this.ctx.storage.put(`logs:${sid}`, trimmed);
      }
    } else if (event.type === "session:complete") {
      const existing = await this.ctx.storage.get<SessionState>(`session:${event.sessionId}`);
      if (existing) {
        existing.status = "complete";
        existing.activeSources = [];
        existing.lastUpdatedAt = now;
        await this.ctx.storage.put(`session:${existing.sessionId}`, existing);
      }
    } else if (event.type === "session:cancelled") {
      const existing = await this.ctx.storage.get<SessionState>(`session:${event.sessionId}`);
      if (existing) {
        existing.status = "cancelled";
        existing.activeSources = [];
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
      if (!session.dismissed) {
        sessions.push(session);
      }
    }

    sessions.sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return b.startedAt - a.startedAt;
    });
    return sessions;
  }
}
