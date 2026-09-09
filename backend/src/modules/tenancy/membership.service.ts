import { prisma } from "../../config/prisma.js";
import type { Prisma } from "../../generated/prisma/index.js";

export type TenantRole = "OWNER" | "ADMIN" | "EDITOR" | "PUBLISHER" | "VIEWER";

export interface TenantMembership {
  tenantId: string;
  tenantName: string;
  tenantStatus: "ACTIVE" | "SUSPENDED" | "DELETED";
  userId: string;
  role: TenantRole;
  membershipStatus: "ACTIVE" | "SUSPENDED";
  version: bigint;
}

interface MembershipRow {
  tenant_id: string;
  tenant_name: string;
  tenant_status: "ACTIVE" | "SUSPENDED" | "DELETED";
  user_id: string;
  role: TenantRole;
  membership_status: "ACTIVE" | "SUSPENDED";
  version: bigint;
}

function mapMembership(row: MembershipRow): TenantMembership {
  return {
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantStatus: row.tenant_status,
    userId: row.user_id,
    role: row.role,
    membershipStatus: row.membership_status,
    version: row.version,
  };
}

async function withVerifiedUserScope<T>(
  userId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    return work(tx);
  });
}

export async function listActiveTenantMemberships(userId: string): Promise<TenantMembership[]> {
  return withVerifiedUserScope(userId, async (tx) => {
    const rows = await tx.$queryRaw<MembershipRow[]>`
      SELECT
        m.tenant_id,
        t.name AS tenant_name,
        t.status AS tenant_status,
        m.user_id,
        m.role,
        m.status AS membership_status,
        m.version
      FROM platform.memberships m
      JOIN platform.tenants t ON t.id = m.tenant_id
      WHERE m.user_id = ${userId}::uuid
        AND m.status = 'ACTIVE'
        AND t.status = 'ACTIVE'
      ORDER BY t.created_at ASC, m.tenant_id ASC
    `;
    return rows.map(mapMembership);
  });
}

export async function resolveActiveTenantMembership(
  userId: string,
  tenantId: string,
): Promise<TenantMembership | null> {
  return withVerifiedUserScope(userId, async (tx) => {
    const rows = await tx.$queryRaw<MembershipRow[]>`
      SELECT
        m.tenant_id,
        t.name AS tenant_name,
        t.status AS tenant_status,
        m.user_id,
        m.role,
        m.status AS membership_status,
        m.version
      FROM platform.memberships m
      JOIN platform.tenants t ON t.id = m.tenant_id
      WHERE m.user_id = ${userId}::uuid
        AND m.tenant_id = ${tenantId}::uuid
        AND m.status = 'ACTIVE'
        AND t.status = 'ACTIVE'
      LIMIT 1
    `;
    return rows[0] ? mapMembership(rows[0]) : null;
  });
}
