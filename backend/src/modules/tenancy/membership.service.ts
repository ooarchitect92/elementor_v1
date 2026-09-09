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
  user_id: string;
  role: TenantRole;
  membership_status: "ACTIVE" | "SUSPENDED";
  version: bigint;
}

interface TenantRow {
  id: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
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

async function readTenantWithinScope(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<TenantRow | null> {
  await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  const tenants = await tx.$queryRaw<TenantRow[]>`
    SELECT id, name, status
    FROM platform.tenants
    WHERE id = ${tenantId}::uuid
    LIMIT 1
  `;
  return tenants[0] ?? null;
}

export async function listActiveTenantMemberships(userId: string): Promise<TenantMembership[]> {
  return withVerifiedUserScope(userId, async (tx) => {
    const memberships = await tx.$queryRaw<MembershipRow[]>`
      SELECT
        tenant_id,
        user_id,
        role,
        status AS membership_status,
        version
      FROM platform.memberships
      WHERE user_id = ${userId}::uuid
        AND status = 'ACTIVE'
      ORDER BY tenant_id ASC
    `;

    const result: TenantMembership[] = [];
    for (const membership of memberships) {
      const tenant = await readTenantWithinScope(tx, membership.tenant_id);
      if (!tenant || tenant.status !== "ACTIVE") continue;
      result.push({
        tenantId: membership.tenant_id,
        tenantName: tenant.name,
        tenantStatus: tenant.status,
        userId: membership.user_id,
        role: membership.role,
        membershipStatus: membership.membership_status,
        version: membership.version,
      });
    }
    return result;
  });
}

export async function resolveActiveTenantMembership(
  userId: string,
  tenantId: string,
): Promise<TenantMembership | null> {
  return withVerifiedUserScope(userId, async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    const memberships = await tx.$queryRaw<MembershipRow[]>`
      SELECT
        tenant_id,
        user_id,
        role,
        status AS membership_status,
        version
      FROM platform.memberships
      WHERE user_id = ${userId}::uuid
        AND tenant_id = ${tenantId}::uuid
        AND status = 'ACTIVE'
      LIMIT 1
    `;
    const membership = memberships[0];
    if (!membership) return null;

    const tenant = await readTenantWithinScope(tx, tenantId);
    if (!tenant || tenant.status !== "ACTIVE") return null;

    return {
      tenantId: membership.tenant_id,
      tenantName: tenant.name,
      tenantStatus: tenant.status,
      userId: membership.user_id,
      role: membership.role,
      membershipStatus: membership.membership_status,
      version: membership.version,
    };
  });
}
