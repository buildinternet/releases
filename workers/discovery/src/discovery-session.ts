import { DurableObject } from "cloudflare:workers";
import { getSandbox, parseSSEStream } from "@cloudflare/sandbox";
import type { LogEvent } from "@cloudflare/sandbox";
import type { Env, StatusResponse } from "./types.js";

type SessionStatus = "idle" | "running" | "complete" | "error";

interface DiscoveryParams {
  company: string;
  domain?: string;
  githubOrg?: string;
}

const POLL_INTERVAL_MS = 15_000;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

export class DiscoverySession extends DurableObject<Env> {
  private sandbox?: ReturnType<typeof getSandbox>;

  /** Sandbox container name is capped at 63 chars by Cloudflare. */
  private get sessionId(): string {
    return this.ctx.id.toString().slice(0, 63);
  }

  private async getState<T>(key: string, fallback: T): Promise<T> {
    const val = await this.ctx.storage.get<T>(key);
    return val ?? fallback;
  }

  private getSandboxHandle() {
    if (!this.sandbox) {
      // sleepAfter (vs keepAlive:true) ensures orphaned containers from old deploys
      // clean up instead of lingering indefinitely. Polls every 15s count as activity.
      this.sandbox = getSandbox(this.env.Sandbox, this.sessionId, { sleepAfter: "7m" });
    }
    return this.sandbox;
  }

  private async destroySandbox(): Promise<void> {
    try { await this.getSandboxHandle().destroy(); } catch { /* container already gone */ }
  }

  private async notifyStatusHub(event: Record<string, unknown>): Promise<void> {
    try {
      const url = `${this.env.RELEASED_API_URL}/v1/status/event`;
      console.log(`[status-hub] POST ${url}`, JSON.stringify(event).slice(0, 200));
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.env.RELEASED_API_KEY
            ? { Authorization: `Bearer ${this.env.RELEASED_API_KEY}` }
            : {}),
        },
        body: JSON.stringify(event),
      });
      if (!res.ok) {
        console.error(`[status-hub] Failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.error(`[status-hub] Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async startDiscovery(params: DiscoveryParams): Promise<{ sessionId: string }> {
    const currentStatus = await this.getState<SessionStatus>("status", "idle");
    if (currentStatus === "running") {
      throw new Error("Discovery already in progress for this session");
    }

    console.log(`[discovery:${this.sessionId}] startDiscovery company=${params.company}`);

    await this.ctx.storage.put({ params, status: "running", startedAt: Date.now() });
    await this.ctx.storage.delete(["errorMessage", "result", "progress"]);

    await this.ctx.storage.setAlarm(Date.now());

    await this.notifyStatusHub({
      type: "session:start",
      sessionId: this.sessionId,
      company: params.company,
    });

    return { sessionId: this.sessionId };
  }

  async alarm(): Promise<void> {
    const status = await this.getState<SessionStatus>("status", "idle");
    if (status !== "running") return;

    const params = await this.getState<DiscoveryParams | null>("params", null);
    if (params) {
      await this.launchProcess(params);
    } else {
      await this.pollProgress();
    }
  }

  private async launchProcess(params: DiscoveryParams): Promise<void> {
    const sandbox = this.getSandboxHandle();

    try {
      console.log(`[discovery:${this.sessionId}] launchProcess: setting up sandbox`);
      // Set env vars on the container so all processes inherit them
      const envVars: Record<string, string> = {
        ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
        CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
        RELEASED_API_URL: this.env.RELEASED_API_URL,
        RELEASED_API_KEY: this.env.RELEASED_API_KEY,
      };
      if (this.env.GITHUB_TOKEN) envVars.GITHUB_TOKEN = this.env.GITHUB_TOKEN;
      await sandbox.setEnvVars(envVars);

      // Start WebSocket log server in the sandbox
      await sandbox.startProcess("bun /app/workers/discovery/src/sandbox-ws.ts &");

      const args = [JSON.stringify(params.company)];
      if (params.domain) args.push("--domain", params.domain);
      if (params.githubOrg) args.push("--github-org", params.githubOrg);
      const cmd = `bun /app/src/agent/run-discovery.ts ${args.join(" ")}`;
      console.log(`[discovery:${this.sessionId}] startProcess: ${cmd}`);

      const proc = await sandbox.startProcess(cmd);
      console.log(`[discovery:${this.sessionId}] process started (id=${proc.id})`);
      await this.ctx.storage.put("agentProcessId", proc.id);

      // Connect to sandbox log stream (best-effort — falls back to polling)
      await this.connectToSandboxLogs();

      // Stream raw stdout/stderr via Sandbox SDK (best-effort)
      this.streamStdout(proc.id);

      await this.ctx.storage.delete("params");
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[discovery:${this.sessionId}] launchProcess failed: ${errMsg}`);
      await this.ctx.storage.put({ status: "error", errorMessage: errMsg });
      await this.notifyStatusHub({
        type: "session:error",
        sessionId: this.sessionId,
        error: errMsg,
      });
      await this.destroySandbox();
    }
  }

  private async connectToSandboxLogs(): Promise<void> {
    try {
      const sandbox = this.getSandboxHandle();
      const wsUpgradeRequest = new Request("http://localhost:8081", {
        headers: { Upgrade: "websocket" },
      });
      const response = await sandbox.wsConnect(wsUpgradeRequest, 8081);
      const ws = response.webSocket;
      if (!ws) {
        console.log(`[discovery:${this.sessionId}] sandbox WS upgrade failed — no webSocket on response`);
        return;
      }
      ws.accept();

      ws.addEventListener("message", async (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : "";
        try {
          const msg = JSON.parse(data);

          // Final state delivered over WS — store directly, no file polling needed
          if (msg.type === "state" && msg.payload) {
            const isError = msg.payload.status === "error";
            console.log(`[discovery:${this.sessionId}] received state via WS (status=${msg.payload.status})`);

            if (isError) {
              await this.ctx.storage.put({
                status: "error",
                errorMessage: msg.payload.error || "Discovery agent failed",
                result: msg.payload,
              });
              await this.notifyStatusHub({
                type: "session:error",
                sessionId: this.sessionId,
                error: msg.payload.error || "Discovery agent failed",
              });
            } else {
              await this.ctx.storage.put({ status: "complete", result: msg.payload });
              await this.notifyStatusHub({
                type: "session:complete",
                sessionId: this.sessionId,
              });
            }
            await this.ctx.storage.deleteAlarm();
            await this.destroySandbox();
            return;
          }

          // Regular log/progress message
          await this.notifyStatusHub({
            type: "session:progress",
            sessionId: this.sessionId,
            ...msg,
          });
        } catch {
          await this.notifyStatusHub({
            type: "session:progress",
            sessionId: this.sessionId,
            currentAction: data,
            logLine: data,
            timestamp: Date.now(),
          });
        }
      });

      ws.addEventListener("close", () => {
        console.log(`[discovery:${this.sessionId}] sandbox WS closed`);
      });

      ws.addEventListener("error", () => {
        console.log(`[discovery:${this.sessionId}] sandbox WS error — falling back to polling`);
      });
    } catch {
      console.log(`[discovery:${this.sessionId}] sandbox WS unavailable — using poll fallback`);
    }
  }

  /** Stream raw stdout/stderr from the agent process via Sandbox SDK. Fire-and-forget. */
  private streamStdout(processId: string): void {
    const sandbox = this.getSandboxHandle();
    sandbox.streamProcessLogs(processId).then(async (stream) => {
      for await (const log of parseSSEStream<LogEvent>(stream)) {
        await this.notifyStatusHub({
          type: "session:stdout",
          sessionId: this.sessionId,
          line: log.data ?? "",
          stream: log.type === "stderr" ? "stderr" : "stdout",
          timestamp: Date.now(),
        });
      }
    }).catch((err) => {
      console.log(`[discovery:${this.sessionId}] stdout stream unavailable: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async pollProgress(): Promise<void> {
    const sandbox = this.getSandboxHandle();
    const startedAt = await this.getState<number>("startedAt", Date.now());
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    console.log(`[discovery:${this.sessionId}] pollProgress (${elapsed}s elapsed)`);

    try {
      const progressFile = await sandbox.readFile("/tmp/discovery-progress.json");
      const progress = JSON.parse(progressFile.content);
      console.log(`[discovery:${this.sessionId}] progress: step=${progress.step} sources=${progress.sourcesFound} validated=${progress.sourcesValidated}`);

      await this.ctx.storage.put("progress", progress);

      await this.notifyStatusHub({
        type: "session:progress",
        sessionId: this.sessionId,
        step: progress.step,
        sourcesFound: progress.sourcesFound,
        sourcesValidated: progress.sourcesValidated,
        currentAction: progress.currentAction,
      });

      if (progress.step === "complete") {
        try {
          const stateFile = await sandbox.readFile("/tmp/discovery-state.json");
          await this.ctx.storage.put("result", JSON.parse(stateFile.content));
          console.log(`[discovery:${this.sessionId}] complete — state file persisted`);
        } catch {
          await this.ctx.storage.put("result", progress);
          console.log(`[discovery:${this.sessionId}] complete — no state file, stored progress`);
        }
        await this.ctx.storage.put("status", "complete");
        await this.notifyStatusHub({
          type: "session:complete",
          sessionId: this.sessionId,
        });
        await this.destroySandbox();
        return;
      }

      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[discovery:${this.sessionId}] progress file not found: ${msg.slice(0, 200)}`);

      // Check if the agent wrote an error state file before crashing
      try {
        const stateFile = await sandbox.readFile("/tmp/discovery-state.json");
        const state = JSON.parse(stateFile.content);
        if (state.status === "error") {
          console.error(`[discovery:${this.sessionId}] agent error: ${JSON.stringify(state).slice(0, 500)}`);
          await this.ctx.storage.put({ status: "error", errorMessage: state.error || "Discovery agent failed", result: state });
          await this.notifyStatusHub({
            type: "session:error",
            sessionId: this.sessionId,
            error: state.error || "Discovery agent failed",
          });
          await this.destroySandbox();
          return;
        }
      } catch {
        // No state file either
      }

      if (msg.includes("not running") || msg.includes("Sandbox error") || msg.includes("proxying request")) {
        console.error(`[discovery:${this.sessionId}] container terminated: ${msg}`);
        await this.ctx.storage.put({ status: "error", errorMessage: `Container terminated: ${msg}` });
        await this.notifyStatusHub({
          type: "session:error",
          sessionId: this.sessionId,
          error: `Container terminated: ${msg}`,
        });
        return;
      }

      if (startedAt > 0 && Date.now() - startedAt > SESSION_TIMEOUT_MS) {
        console.error(`[discovery:${this.sessionId}] session timed out`);
        await this.ctx.storage.put({ status: "error", errorMessage: "Session timed out (no progress after 10 minutes)" });
        await this.notifyStatusHub({
          type: "session:error",
          sessionId: this.sessionId,
          error: "Session timed out (no progress after 10 minutes)",
        });
        await this.destroySandbox();
        return;
      }

      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  async getStatus(): Promise<StatusResponse> {
    const status = await this.getState<SessionStatus>("status", "idle");

    if (status === "idle") return { status: "idle" };

    if (status === "error") {
      const errorMessage = await this.getState<string>("errorMessage", "Unknown error");
      return { status: "error", error: errorMessage };
    }

    if (status === "complete") {
      const result = await this.getState<object | null>("result", null);
      return { status: "complete", result: result ?? undefined };
    }

    const progress = await this.getState<StatusResponse["progress"] | null>("progress", null);
    return { status: "running", progress: progress ?? undefined };
  }
}
