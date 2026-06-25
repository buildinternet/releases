import { Label, Textarea } from "@releases/design-system";

export function ReleaseNote() {
  return (
    <div style={{ width: 440 }}>
      <Label htmlFor="description">Description</Label>
      <Textarea
        id="description"
        rows={4}
        defaultValue={`Vercel is the platform for frontend developers, providing the speed and reliability innovators need to create at the moment of inspiration.\n\nTrack release notes, SDK updates, and platform announcements from the official changelog.`}
      />
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ width: 440 }}>
      <Label htmlFor="release-notes">Release notes</Label>
      <Textarea
        id="release-notes"
        rows={3}
        disabled
        defaultValue={`v2.4.0 — Fixed a rendering issue in the edge runtime for dynamically imported components. Improved error boundaries for streaming responses.`}
      />
    </div>
  );
}
