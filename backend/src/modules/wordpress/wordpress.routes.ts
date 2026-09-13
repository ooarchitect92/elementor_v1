import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.middleware.js";
import { AppError } from "../../utils/app-error.js";
import {
  checkWordPressConnection,
  importWordPressSnapshot,
  listWordPressConnections,
  listWordPressImports,
  pairWordPress,
  revokeWordPressConnection,
} from "./wordpress.service.js";
import {
  generateWordPressCompatibilityPassport,
  getLatestWordPressCompatibilityPassport,
  listWordPressSourceSnapshots,
} from "./wordpress-passport.service.js";
import { queueWordPressSync } from "./wordpress-sync.service.js";

const router = Router();
router.use(requireAuth);

function uid(res: Response) {
  const value = res.locals.user?.id;
  if (!value) throw new AppError("Authentication required", 401, "AUTH_REQUIRED");
  return String(value);
}

router.get("/websites/:websiteId/wordpress/connections", async (req: Request, res: Response, next: NextFunction) => {
  try { return res.json({ success: true, connections: await listWordPressConnections(String(req.params.websiteId), uid(res)) }); }
  catch (error) { next(error); }
});

router.post("/websites/:websiteId/wordpress/connections", async (req, res, next) => {
  try {
    const connection = await pairWordPress(String(req.params.websiteId), uid(res), {
      siteUrl: String(req.body?.siteUrl || ""),
      username: String(req.body?.username || ""),
      applicationPassword: String(req.body?.applicationPassword || ""),
    });
    return res.status(201).json({ success: true, connection });
  } catch (error) { next(error); }
});

router.post("/websites/:websiteId/wordpress/connections/:connectionId/check", async (req, res, next) => {
  try { return res.json({ success: true, connection: await checkWordPressConnection(String(req.params.websiteId), String(req.params.connectionId), uid(res)) }); }
  catch (error) { next(error); }
});

router.delete("/websites/:websiteId/wordpress/connections/:connectionId", async (req, res, next) => {
  try { return res.json({ success: true, ...(await revokeWordPressConnection(String(req.params.websiteId), String(req.params.connectionId), uid(res))) }); }
  catch (error) { next(error); }
});

router.post("/websites/:websiteId/wordpress/connections/:connectionId/import", async (req, res, next) => {
  try {
    const result = await importWordPressSnapshot(
      String(req.params.websiteId),
      String(req.params.connectionId),
      uid(res),
      Number(req.body?.maxItems || 1000),
    );
    return res.status(201).json({ success: true, import: result });
  } catch (error) { next(error); }
});

router.get("/websites/:websiteId/wordpress/connections/:connectionId/imports", async (req, res, next) => {
  try { return res.json({ success: true, imports: await listWordPressImports(String(req.params.websiteId), String(req.params.connectionId), uid(res)) }); }
  catch (error) { next(error); }
});

router.get("/websites/:websiteId/wordpress/connections/:connectionId/snapshots", async (req, res, next) => {
  try {
    const snapshots = await listWordPressSourceSnapshots(
      String(req.params.websiteId),
      String(req.params.connectionId),
      uid(res),
      typeof req.query.type === "string" ? req.query.type : undefined,
      Number(req.query.limit || 100),
    );
    return res.json({ success: true, snapshots });
  } catch (error) { next(error); }
});

router.post("/websites/:websiteId/wordpress/connections/:connectionId/passport", async (req, res, next) => {
  try {
    const passport = await generateWordPressCompatibilityPassport(
      String(req.params.websiteId),
      String(req.params.connectionId),
      uid(res),
    );
    return res.status(201).json({ success: true, passport });
  } catch (error) { next(error); }
});

router.get("/websites/:websiteId/wordpress/connections/:connectionId/passport", async (req, res, next) => {
  try {
    const passport = await getLatestWordPressCompatibilityPassport(
      String(req.params.websiteId),
      String(req.params.connectionId),
      uid(res),
    );
    return res.json({ success: true, passport });
  } catch (error) { next(error); }
});

router.post("/websites/:websiteId/wordpress/connections/:connectionId/sync", async (req, res, next) => {
  try {
    const job = await queueWordPressSync(
      String(req.params.websiteId),
      String(req.params.connectionId),
      uid(res),
      {
        requestKey: String(req.body?.requestKey || req.headers["idempotency-key"] || ""),
        sourceType: String(req.body?.sourceType || ""),
        sourceId: String(req.body?.sourceId || ""),
        expectedSourceHash: String(req.body?.expectedSourceHash || ""),
        desired: req.body?.desired,
        requestId: res.locals.requestId,
      },
    );
    return res.status(job.duplicate ? 200 : 202).json({ success: true, job });
  } catch (error) { next(error); }
});

export default router;
