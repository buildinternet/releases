import { Input, Label } from "@releases/design-system";

export function TextField() {
  return (
    <div style={{ width: 360 }}>
      <Label htmlFor="display-name">Display name</Label>
      <Input id="display-name" defaultValue="Vercel" />
    </div>
  );
}

export function Email() {
  return (
    <div style={{ width: 360 }}>
      <Label htmlFor="contact-email">Email address</Label>
      <Input id="contact-email" type="email" defaultValue="zach@buildinternet.com" />
    </div>
  );
}

export function WithPlaceholder() {
  return (
    <div style={{ width: 360 }}>
      <Label htmlFor="source-url">Source URL</Label>
      <Input id="source-url" placeholder="github.com/owner/repo" />
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ width: 360 }}>
      <Label htmlFor="api-token">API token</Label>
      <Input id="api-token" disabled defaultValue="relk_7xQk2A_••••••••••••••••" />
    </div>
  );
}
