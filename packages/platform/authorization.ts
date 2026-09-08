import { uuid } from '../events/index.ts';
export type Permission = 'site.read' | 'site.edit' | 'site.publish' | 'members.manage' | 'billing.manage' | 'integrations.manage';
export type Role = 'OWNER' | 'ADMIN' | 'EDITOR' | 'PUBLISHER' | 'VIEWER';
const grants: Record<Role, readonly Permission[]> = {
  OWNER: ['site.read', 'site.edit', 'site.publish', 'members.manage', 'billing.manage', 'integrations.manage'],
  ADMIN: ['site.read', 'site.edit', 'site.publish', 'members.manage', 'integrations.manage'],
  EDITOR: ['site.read', 'site.edit'], PUBLISHER: ['site.read', 'site.publish'], VIEWER: ['site.read']
};
/** Resolve from server-verified session + persisted membership, NEVER request JSON. */
export interface Membership {
  tenantId: string; userId: string; role: Role; status: 'ACTIVE' | 'SUSPENDED';
}
export function authorize(membership: Membership | null, userId: string, resourceTenantId: string, permission: Permission): void {
  const user = uuid(userId); const tenant = uuid(resourceTenantId);
  if (!membership || uuid(membership.userId) !== user || uuid(membership.tenantId) !== tenant || membership.status !== 'ACTIVE' || !grants[membership.role]?.includes(permission)) throw new Error('FORBIDDEN');
}
