import { Toggle } from "@releases/design-system";

function Row({
  title,
  desc,
  checked,
  disabled,
}: {
  title: string;
  desc: string;
  checked: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 28,
        width: 380,
        padding: "10px 0",
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: "#1c1917" }}>{title}</div>
        <div style={{ fontSize: 13, color: "#78716c", marginTop: 2 }}>{desc}</div>
      </div>
      <Toggle checked={checked} disabled={disabled} onChange={() => {}} label={title} />
    </div>
  );
}

export function On() {
  return (
    <Row
      title="Email notifications"
      desc="Get notified when a followed product ships."
      checked={true}
    />
  );
}

export function Off() {
  return <Row title="Weekly digest" desc="A Monday summary of everything new." checked={false} />;
}

export function Disabled() {
  return (
    <Row title="SMS alerts" desc="Coming soon — not yet available." checked={false} disabled />
  );
}
