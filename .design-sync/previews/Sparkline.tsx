import { Sparkline } from "@releases/design-system";

function StatCard({
  label,
  count,
  data,
  id,
  color,
}: {
  label: string;
  count: string;
  data: number[];
  id: string;
  color?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "12px 16px",
        borderRadius: 12,
        border: "1px solid #e7e5e4",
        background: "#fafaf9",
        minWidth: 140,
        color: "#44403c",
      }}
    >
      <div style={{ fontSize: 11, color: "#78716c", fontWeight: 500, letterSpacing: "0.02em" }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, color: "#1c1917", lineHeight: 1 }}>{count}</div>
      <Sparkline data={data} id={id} width={108} height={28} color={color ?? "#a8a29e"} />
    </div>
  );
}

export function ReleaseCadence() {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <StatCard
        label="Vercel / releases"
        count="31"
        data={[2, 3, 1, 5, 4, 6, 3, 7]}
        id="vercel-cadence"
        color="#7c3aed"
      />
      <StatCard
        label="Stripe / releases"
        count="18"
        data={[1, 2, 4, 2, 3, 1, 4, 2]}
        id="stripe-cadence"
        color="#0ea5e9"
      />
      <StatCard
        label="Linear / releases"
        count="9"
        data={[0, 1, 2, 1, 3, 2, 1, 2]}
        id="linear-cadence"
        color="#10b981"
      />
    </div>
  );
}

export function Accent() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "16px 20px",
        borderRadius: 12,
        border: "1px solid #e7e5e4",
        background: "#fafaf9",
        color: "var(--accent)",
        width: 180,
      }}
    >
      <div style={{ fontSize: 11, color: "#78716c", fontWeight: 500 }}>Releases this month</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: "#1c1917", lineHeight: 1 }}>47</div>
      <Sparkline
        data={[3, 5, 2, 8, 6, 9, 4, 11]}
        id="accent-line"
        width={140}
        height={32}
        color="var(--accent)"
      />
    </div>
  );
}

export function Flat() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "16px 20px",
        borderRadius: 12,
        border: "1px solid #e7e5e4",
        background: "#fafaf9",
        color: "#a8a29e",
        width: 180,
      }}
    >
      <div style={{ fontSize: 11, color: "#78716c", fontWeight: 500 }}>Releases this month</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: "#1c1917", lineHeight: 1 }}>0</div>
      <Sparkline data={[0, 0, 0, 0, 0, 0, 0, 0]} id="flat-line" width={140} height={32} />
    </div>
  );
}
