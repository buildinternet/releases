import { Card, Eyebrow } from "@releases/design-system";

export function ReleaseCard() {
  return (
    <div style={{ width: 380 }}>
      <Card>
        <div style={{ padding: "16px 20px 20px" }}>
          <Eyebrow tone="accent">RELEASE</Eyebrow>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: "#1c1917",
              marginTop: 8,
              lineHeight: 1.3,
            }}
          >
            v15.2.0 — Turbopack stable
          </div>
          <div style={{ fontSize: 14, color: "#57534e", marginTop: 6, lineHeight: 1.55 }}>
            Turbopack is now stable for both dev and build. Compile times drop up to 72% on large
            apps.
          </div>
          <div style={{ fontSize: 12, color: "#78716c", marginTop: 12 }}>
            Dec 14, 2024 · next.js
          </div>
        </div>
      </Card>
    </div>
  );
}

export function Stat() {
  return (
    <div style={{ width: 220 }}>
      <Card>
        <div style={{ padding: "18px 20px 20px" }}>
          <Eyebrow>SOURCES TRACKED</Eyebrow>
          <div
            style={{ fontSize: 34, fontWeight: 700, color: "#1c1917", marginTop: 8, lineHeight: 1 }}
          >
            1,284
          </div>
          <div style={{ fontSize: 12, color: "#78716c", marginTop: 6 }}>+12 this week</div>
        </div>
      </Card>
    </div>
  );
}

export function OrgCard() {
  return (
    <div style={{ width: 380 }}>
      <Card>
        <div style={{ padding: "18px 20px 20px" }}>
          <Eyebrow>ORG</Eyebrow>
          <div style={{ fontSize: 17, fontWeight: 600, color: "#1c1917", marginTop: 8 }}>
            Stripe
          </div>
          <div style={{ fontSize: 13, color: "#57534e", marginTop: 5, lineHeight: 1.5 }}>
            Payment infrastructure for the internet. Tracks 4 sources including the Stripe API
            changelog and the Stripe blog.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "#78716c" }}>48 releases this year</div>
            <div style={{ fontSize: 12, color: "#78716c" }}>·</div>
            <div style={{ fontSize: 12, color: "#78716c" }}>4 products</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
