import { Input, Label, Textarea } from "@releases/design-system";

export function FieldLabel() {
  return (
    <div style={{ width: 360 }}>
      <Label htmlFor="source-url">Source URL</Label>
      <Input id="source-url" defaultValue="https://vercel.com/changelog" />
    </div>
  );
}

export function Required() {
  return (
    <div style={{ width: 360 }}>
      <Label htmlFor="org-slug">
        Organization slug
        <span style={{ color: "#ef4444", marginLeft: 4 }}>*</span>
      </Label>
      <Input id="org-slug" defaultValue="vercel" />
    </div>
  );
}

export function TextareaLabel() {
  return (
    <div style={{ width: 440 }}>
      <Label htmlFor="overview">Overview</Label>
      <Textarea
        id="overview"
        rows={3}
        defaultValue={`Releases from Vercel — the platform for frontend developers. Covers the changelog, CLI, Next.js, and SDK announcements.`}
      />
    </div>
  );
}
