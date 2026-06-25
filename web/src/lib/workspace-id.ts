const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_RE.test(id);
}
