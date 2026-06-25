import { Aside, Card, Eyebrow, PanelGrid } from "@releases/design-system";

export function WithAside() {
  return (
    <div style={{ padding: "24px 28px", maxWidth: 1000 }}>
      <PanelGrid
        aside={
          <Aside label="ABOUT">
            <p style={{ fontSize: 13, color: "#57534e", lineHeight: 1.6, marginTop: 0 }}>
              API keys grant programmatic access to your Releases data. Keep them secret and rotate
              them if compromised.
            </p>
            <p style={{ fontSize: 13, color: "#57534e", lineHeight: 1.6, marginTop: 10 }}>
              Each key is scoped to{" "}
              <strong style={{ color: "#1c1917", fontWeight: 500 }}>read</strong> access.
              Write-scoped keys are available on the Pro plan.
            </p>
          </Aside>
        }
      >
        <div>
          <Eyebrow tone="accent">API ACCESS</Eyebrow>
          <div
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: "#1c1917",
              marginTop: 8,
              marginBottom: 16,
            }}
          >
            API Keys
          </div>
          <Card>
            <div style={{ padding: "16px 20px 20px" }}>
              <div style={{ fontSize: 13, color: "#57534e", lineHeight: 1.55 }}>
                Use these keys to authenticate requests to the Releases API from your own tools,
                scripts, or CI pipelines.
              </div>
              <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>
                  Production key
                </div>
                <div style={{ fontSize: 13, color: "#78716c", fontFamily: "monospace" }}>
                  relk_••••••••4f2a
                </div>
              </div>
            </div>
          </Card>
        </div>
      </PanelGrid>
    </div>
  );
}

export function NoAside() {
  return (
    <div style={{ padding: "24px 28px" }}>
      <PanelGrid>
        <div>
          <Eyebrow tone="accent">NOTIFICATIONS</Eyebrow>
          <div
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: "#1c1917",
              marginTop: 8,
              marginBottom: 16,
            }}
          >
            Email preferences
          </div>
          <Card>
            <div style={{ padding: "16px 20px 20px" }}>
              <div style={{ fontSize: 13, color: "#57534e", lineHeight: 1.55 }}>
                Choose which release activity triggers an email digest. Digests are sent at most
                once per day per followed org.
              </div>
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 13,
                    color: "#1c1917",
                  }}
                >
                  <input type="checkbox" defaultChecked readOnly /> Major releases
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 13,
                    color: "#1c1917",
                  }}
                >
                  <input type="checkbox" defaultChecked readOnly /> Breaking changes
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 13,
                    color: "#57534e",
                  }}
                >
                  <input type="checkbox" readOnly /> All releases
                </label>
              </div>
            </div>
          </Card>
        </div>
      </PanelGrid>
    </div>
  );
}
