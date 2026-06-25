import { PreviewBanner } from "@releases/design-system";

const WebhookIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 16.016a4 4 0 1 1-4 0V9h4v7.016z" />
    <path d="M6 8a4 4 0 1 1 4 0V5H6v3z" />
    <path d="M14 9H6" />
  </svg>
);

export function Webhooks() {
  return (
    <div style={{ width: 480 }}>
      <PreviewBanner title="Webhooks — coming soon" icon={<WebhookIcon />}>
        Real-time delivery when a followed product ships. Register an endpoint and get pinged within
        seconds of a new release.
      </PreviewBanner>
    </div>
  );
}

export function ApiKeys() {
  return (
    <div style={{ width: 480 }}>
      <PreviewBanner title="Personal API keys — in preview">
        Generate a read-only key for your account and query the Releases API directly from your own
        tools and scripts.
      </PreviewBanner>
    </div>
  );
}

export function WithoutIcon() {
  return (
    <div style={{ width: 480 }}>
      <PreviewBanner title="MCP server — early access">
        Connect Releases to Claude and other AI clients via the Model Context Protocol. Ask your
        agent what shipped this week.
      </PreviewBanner>
    </div>
  );
}
