import type { Sandbox } from "@cloudflare/sandbox";

export interface OnboardRequest {
  company: string;
  domain?: string;
  githubOrg?: string;
  dbSnapshot?: string; // base64-encoded SQLite DB file (optional — fresh DB if omitted)
}

export interface OnboardResponse {
  sessionId: string;
  status: "running";
}

export interface StatusResponse {
  status: "running" | "complete" | "error" | "idle";
  progress?: {
    step: string;
    sourcesFound: number;
    sourcesValidated: number;
    currentAction: string;
  };
  result?: object; // DiscoveryState JSON
  error?: string;
}

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  DISCOVERY_SESSION: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  GITHUB_TOKEN?: string;
  API_SECRET?: string;
}
