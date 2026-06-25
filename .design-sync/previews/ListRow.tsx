import { ListCard, ListRow } from "@releases/design-system";

export function ApiKeyRow() {
  return (
    <div style={{ width: 480 }}>
      <ListCard>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>Production</div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2, fontFamily: "monospace" }}>
              relk_••••••••••••••••4f2a
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#78716c", flexShrink: 0 }}>Revoke</div>
        </ListRow>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>
              CI / GitHub Actions
            </div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2, fontFamily: "monospace" }}>
              relk_••••••••••••••••8c71
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#78716c", flexShrink: 0 }}>Revoke</div>
        </ListRow>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>Local dev</div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2, fontFamily: "monospace" }}>
              relk_••••••••••••••••b39d
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#78716c", flexShrink: 0 }}>Revoke</div>
        </ListRow>
      </ListCard>
    </div>
  );
}

export function WebhookRow() {
  return (
    <div style={{ width: 480 }}>
      <ListCard>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>Slack — #releases</div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2 }}>
              https://hooks.slack.com/services/T0…
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <div
              style={{
                fontSize: 11,
                background: "#f0fdf4",
                color: "#15803d",
                borderRadius: 4,
                padding: "2px 7px",
                fontWeight: 500,
              }}
            >
              active
            </div>
            <div style={{ fontSize: 12, color: "#78716c" }}>Remove</div>
          </div>
        </ListRow>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>Deploy pipeline</div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2 }}>
              https://api.acme.com/webhooks/releases
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <div
              style={{
                fontSize: 11,
                background: "#f0fdf4",
                color: "#15803d",
                borderRadius: 4,
                padding: "2px 7px",
                fontWeight: 500,
              }}
            >
              active
            </div>
            <div style={{ fontSize: 12, color: "#78716c" }}>Remove</div>
          </div>
        </ListRow>
      </ListCard>
    </div>
  );
}
