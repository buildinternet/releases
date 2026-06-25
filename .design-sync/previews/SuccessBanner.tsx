import { SuccessBanner } from "@releases/design-system";

export function Saved() {
  return (
    <div style={{ width: 480 }}>
      <SuccessBanner>Your notification preferences were saved.</SuccessBanner>
    </div>
  );
}

export function Connected() {
  return (
    <div style={{ width: 480 }}>
      <SuccessBanner>GitHub connected — 12 sources now syncing.</SuccessBanner>
    </div>
  );
}

export function KeyRevoked() {
  return (
    <div style={{ width: 480 }}>
      <SuccessBanner>
        API key revoked. Any requests using that token will now be rejected.
      </SuccessBanner>
    </div>
  );
}
