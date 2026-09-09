import type { NextFunction, Request, Response } from "express";
import {
  listActiveTenantMemberships,
  resolveActiveTenantMembership,
  type TenantMembership,
} from "./membership.service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function serializeMembership(membership: TenantMembership) {
  return {
    ...membership,
    version: membership.version.toString(),
  };
}

export async function listTenantContexts(req: Request, res: Response, next: NextFunction) {
  try {
    const user = res.locals.user;
    if (!user?.id) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const memberships = await listActiveTenantMemberships(user.id);
    return res.status(200).json({
      success: true,
      tenants: memberships.map(serializeMembership),
    });
  } catch (error) {
    next(error);
  }
}

export async function requireTenantContext(req: Request, res: Response, next: NextFunction) {
  try {
    const user = res.locals.user;
    if (!user?.id) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const requestedTenant = req.header("x-forgestudio-tenant");

    if (requestedTenant) {
      if (!UUID_PATTERN.test(requestedTenant)) {
        return res.status(400).json({
          success: false,
          code: "INVALID_TENANT_SELECTOR",
          message: "x-forgestudio-tenant must be a UUID",
        });
      }

      const membership = await resolveActiveTenantMembership(user.id, requestedTenant);
      if (!membership) {
        return res.status(403).json({
          success: false,
          code: "TENANT_ACCESS_DENIED",
          message: "No active membership exists for this tenant",
        });
      }

      res.locals.tenant = membership;
      return next();
    }

    const memberships = await listActiveTenantMemberships(user.id);
    if (memberships.length === 0) {
      return res.status(403).json({
        success: false,
        code: "NO_ACTIVE_TENANT",
        message: "No active tenant membership is available",
      });
    }

    if (memberships.length > 1) {
      return res.status(409).json({
        success: false,
        code: "TENANT_SELECTION_REQUIRED",
        message: "Select an active tenant using x-forgestudio-tenant",
        tenants: memberships.map(({ tenantId, tenantName, role }) => ({ tenantId, tenantName, role })),
      });
    }

    res.locals.tenant = memberships[0];
    return next();
  } catch (error) {
    next(error);
  }
}

export function getTenantContext(req: Request, res: Response) {
  const tenant = res.locals.tenant as TenantMembership | undefined;
  if (!tenant) {
    return res.status(500).json({
      success: false,
      code: "TENANT_CONTEXT_MISSING",
      message: "Tenant middleware did not establish a context",
    });
  }

  return res.status(200).json({
    success: true,
    tenant: serializeMembership(tenant),
  });
}
