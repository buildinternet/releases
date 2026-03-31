import type { Sandbox } from "@cloudflare/sandbox";

export interface OnboardRequest {
  company: string;
  domain?: string;
  githubOrg?: string;
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
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  GITHUB_TOKEN?: string;
  RELEASED_API_URL: string;
  RELEASED_API_KEY: string;
  API_WORKER?: Fetcher;
}
