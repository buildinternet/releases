import { Button } from "@releases/design-system";

export function Primary() {
  return <Button variant="primary">Save changes</Button>;
}

export function Secondary() {
  return <Button variant="secondary">Cancel</Button>;
}

export function Variants() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <Button variant="primary">Save changes</Button>
      <Button variant="secondary">Cancel</Button>
      <Button variant="danger">Revoke</Button>
      <Button variant="confirm">Yes, delete source</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Button variant="primary" size="md">
        Add source
      </Button>
      <Button variant="primary" size="sm">
        Add
      </Button>
      <Button variant="secondary" size="md">
        Refresh
      </Button>
      <Button variant="secondary" size="sm">
        Refresh
      </Button>
    </div>
  );
}

export function Disabled() {
  return (
    <Button variant="primary" disabled>
      Saving…
    </Button>
  );
}
