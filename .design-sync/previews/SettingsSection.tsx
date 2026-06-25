import { Button, Card, Input, Label, SettingsSection } from "@releases/design-system";

export function ProfileSettings() {
  return (
    <SettingsSection
      group="Account"
      title="Profile"
      description="This information appears on your public profile and on the releases you curate."
    >
      <Card>
        <div
          style={{ display: "flex", flexDirection: "column", gap: 18, padding: 20, maxWidth: 440 }}
        >
          <div>
            <Label htmlFor="name">Display name</Label>
            <Input id="name" defaultValue="Zach Dunn" />
          </div>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" defaultValue="zach@buildinternet.com" />
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <Button variant="primary">Save changes</Button>
            <Button variant="secondary">Cancel</Button>
          </div>
        </div>
      </Card>
    </SettingsSection>
  );
}
