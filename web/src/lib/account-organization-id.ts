const ORG_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isAccountOrganizationId(id: string): boolean {
  return ORG_ID_RE.test(id);
}
