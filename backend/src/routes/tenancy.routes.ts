import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import {
  getTenantContext,
  listTenantContexts,
  requireTenantContext,
} from "../modules/tenancy/tenant.middleware.js";

const router = Router();

router.get("/memberships", requireAuth, listTenantContexts);
router.get("/context", requireAuth, requireTenantContext, getTenantContext);

export default router;
