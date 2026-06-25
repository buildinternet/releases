import { Aside } from "@releases/design-system";

export function ContextRail() {
  return (
    <div style={{ width: 264, padding: 12 }}>
      <Aside label="ABOUT">
        <p style={{ fontSize: 13, color: "#57534e", lineHeight: 1.6, margin: 0 }}>
          This page shows all releases tracked for Vercel — including Next.js, Turbopack, and the
          Vercel platform changelog.
        </p>
        <p
          style={{
            fontSize: 13,
            color: "#57534e",
            lineHeight: 1.6,
            marginTop: 10,
            marginBottom: 0,
          }}
        >
          Sources are fetched hourly. New releases appear within minutes of being published.
        </p>
      </Aside>
    </div>
  );
}

export function SourceRail() {
  return (
    <div style={{ width: 264, padding: 12 }}>
      <Aside label="SOURCE">
        <p style={{ fontSize: 13, color: "#57534e", lineHeight: 1.6, margin: 0 }}>
          Fetched from{" "}
          <span style={{ color: "#1c1917", fontWeight: 500 }}>stripe.com/changelog</span> via
          scrape. Last successful fetch was 4 minutes ago.
        </p>
        <p
          style={{
            fontSize: 13,
            color: "#57534e",
            lineHeight: 1.6,
            marginTop: 10,
            marginBottom: 0,
          }}
        >
          Extraction uses AI to identify release boundaries and pull structured metadata from the
          page.
        </p>
        <div style={{ marginTop: 12, fontSize: 12, color: "#78716c" }}>Added Jan 8, 2024</div>
      </Aside>
    </div>
  );
}
