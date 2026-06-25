import { ThemeToggle } from "@releases/design-system";

export function Toolbar() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: 420,
        padding: "10px 16px",
        borderBottom: "1px solid #e7e5e4",
        background: "#fafaf9",
        borderRadius: "12px 12px 0 0",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            background: "var(--accent)",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 14, fontWeight: 600, color: "#1c1917" }}>releases.sh</span>
      </div>
      <ThemeToggle />
    </div>
  );
}

export function ToolbarDark() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: 420,
        padding: "10px 16px",
        borderBottom: "1px solid #292524",
        background: "#1c1917",
        borderRadius: "12px 12px 0 0",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            background: "var(--accent)",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 14, fontWeight: 600, color: "#fafaf9" }}>releases.sh</span>
      </div>
      <ThemeToggle />
    </div>
  );
}
