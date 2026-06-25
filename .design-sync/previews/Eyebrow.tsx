import { Eyebrow } from "@releases/design-system";

export function Default() {
  return (
    <div
      style={{
        padding: "20px 24px",
        background: "#fff",
        borderRadius: 12,
        border: "1px solid #e7e5e4",
      }}
    >
      <Eyebrow>ACCOUNT SETTINGS</Eyebrow>
      <div
        style={{ fontSize: 22, fontWeight: 600, color: "#1c1917", marginTop: 10, lineHeight: 1.25 }}
      >
        Profile
      </div>
      <div style={{ fontSize: 13, color: "#57534e", marginTop: 5 }}>
        Manage your display name, email address, and public profile.
      </div>
    </div>
  );
}

export function Accent() {
  return (
    <div
      style={{
        padding: "20px 24px",
        background: "#fff",
        borderRadius: 12,
        border: "1px solid #e7e5e4",
      }}
    >
      <Eyebrow tone="accent">OVERVIEW</Eyebrow>
      <div
        style={{ fontSize: 22, fontWeight: 600, color: "#1c1917", marginTop: 10, lineHeight: 1.25 }}
      >
        Vercel
      </div>
      <div style={{ fontSize: 13, color: "#57534e", marginTop: 5 }}>
        Frontend cloud platform. 6 products tracked, 214 releases this year.
      </div>
    </div>
  );
}

export function Section() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 28,
        padding: "24px 28px",
        maxWidth: 440,
        background: "#fff",
        borderRadius: 12,
        border: "1px solid #e7e5e4",
      }}
    >
      <div>
        <Eyebrow tone="accent">CHANGELOG</Eyebrow>
        <div style={{ fontSize: 20, fontWeight: 600, color: "#1c1917", marginTop: 8 }}>
          Stripe API
        </div>
        <div style={{ fontSize: 13, color: "#57534e", marginTop: 4, lineHeight: 1.5 }}>
          Breaking changes, new endpoints, and deprecation notices for the Stripe API.
        </div>
      </div>
      <div>
        <Eyebrow>CONNECTED SOURCES</Eyebrow>
        <div style={{ fontSize: 18, fontWeight: 600, color: "#1c1917", marginTop: 8 }}>
          3 active
        </div>
        <div style={{ fontSize: 13, color: "#57534e", marginTop: 4 }}>
          stripe.com/changelog · blog.stripe.com · github.com/stripe/stripe-node
        </div>
      </div>
    </div>
  );
}
