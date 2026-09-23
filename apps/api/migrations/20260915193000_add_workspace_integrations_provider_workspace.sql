-- Remote workspace slug the OAuth grant is tied to (uploads.sh JWT `workspace`).
ALTER TABLE workspace_integrations ADD COLUMN provider_workspace TEXT;
