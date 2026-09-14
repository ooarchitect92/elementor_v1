const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PlatformMembershipRole = "OWNER" | "ADMIN" | "PUBLISHER";

function validUuid(value: string, code: string): string {
  if (!UUID.test(value)) throw new Error(code);
  return value.toLowerCase();
}

/**
 * Bridges the legacy owner/collaborator model to the platform tenant boundary.
 * The caller must run this inside the same Prisma transaction as the durable job write.
 */
export async function ensurePlatformTenant(
  tx: any,
  ownerUserId: string,
  actorUserId: string,
  actorRole: PlatformMembershipRole,
): Promise<string> {
  const tenantId = validUuid(ownerUserId, "INVALID_TENANT_OWNER");
  const actorId = validUuid(actorUserId, "INVALID_TENANT_ACTOR");
  if (!["OWNER", "ADMIN", "PUBLISHER"].includes(actorRole)) {
    throw new Error("INVALID_PLATFORM_ROLE");
  }

  await tx.$queryRawUnsafe(
    "SELECT set_config('app.tenant_id', $1, true)",
    tenantId,
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO platform.tenants(id,name,status,home_cell)
     VALUES($1::uuid,$2,'ACTIVE','local-1')
     ON CONFLICT(id) DO UPDATE
       SET status=CASE WHEN platform.tenants.status='DELETED' THEN platform.tenants.status ELSE 'ACTIVE' END`,
    tenantId,
    `Workspace ${tenantId.slice(0, 8)}`,
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO platform.memberships(tenant_id,user_id,role,status)
     VALUES($1::uuid,$1::uuid,'OWNER','ACTIVE')
     ON CONFLICT(tenant_id,user_id) DO UPDATE
       SET role='OWNER',status='ACTIVE',version=platform.memberships.version+1`,
    tenantId,
  );

  if (actorId !== tenantId) {
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.memberships(tenant_id,user_id,role,status)
       VALUES($1::uuid,$2::uuid,$3,'ACTIVE')
       ON CONFLICT(tenant_id,user_id) DO UPDATE
         SET role=CASE WHEN platform.memberships.role='OWNER' THEN 'OWNER' ELSE EXCLUDED.role END,
             status='ACTIVE',version=platform.memberships.version+1`,
      tenantId,
      actorId,
      actorRole,
    );
  }
  return tenantId;
}
