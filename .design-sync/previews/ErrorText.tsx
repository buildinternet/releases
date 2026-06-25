import { ErrorText, Label, Input } from "@releases/design-system";

export function FieldError() {
  return (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="source-url">Source URL</Label>
      <Input
        id="source-url"
        type="url"
        defaultValue="https://vercel.com/changelog"
        aria-describedby="source-url-error"
        aria-invalid="true"
      />
      <ErrorText>That source URL is already indexed.</ErrorText>
    </div>
  );
}

export function WebhookError() {
  return (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="webhook-url">Endpoint URL</Label>
      <Input
        id="webhook-url"
        type="url"
        defaultValue="http://localhost:3000/hook"
        aria-describedby="webhook-url-error"
        aria-invalid="true"
      />
      <ErrorText>Endpoint must use HTTPS.</ErrorText>
    </div>
  );
}

export function ApiKeyNameError() {
  return (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="key-name">Key name</Label>
      <Input
        id="key-name"
        type="text"
        defaultValue=""
        placeholder="e.g. CI / read access"
        aria-describedby="key-name-error"
        aria-invalid="true"
      />
      <ErrorText>Name is required before you can generate a key.</ErrorText>
    </div>
  );
}
