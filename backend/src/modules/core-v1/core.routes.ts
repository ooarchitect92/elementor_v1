import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.middleware.js";
import { AppError } from "../../utils/app-error.js";
import {
  activateRelease,
  getActivePublishedSite,
  getEditorState,
  getRevision,
  listReleases,
  listRevisions,
  publishCurrentRevision,
  saveEditorRevision,
} from "./core.service.js";

const router = Router();

function userId(res: Response): string {
  const id = res.locals.user?.id;
  if (!id) throw new AppError("Authentication required", 401, "AUTH_REQUIRED");
  return id;
}

router.get("/public/sites/:websiteId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const release = await getActivePublishedSite(String(req.params.websiteId));
    const etag = `\"${release.contentHash}\"`;
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300, stale-if-error=86400");
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    return res.status(200).json({ success: true, release });
  } catch (error) { next(error); }
});

router.use(requireAuth);

router.get("/websites/:websiteId/editor-state", async (req, res, next) => {
  try { return res.json({ success: true, website: await getEditorState(String(req.params.websiteId), userId(res)) }); }
  catch (error) { next(error); }
});

router.put("/websites/:websiteId/editor-state", async (req, res, next) => {
  try {
    const result = await saveEditorRevision(String(req.params.websiteId), userId(res), {
      expectedRevision: Number(req.body?.expectedRevision),
      requestKey: String(req.body?.requestKey || ""),
      editorData: req.body?.editorData,
      performanceSettings: req.body?.performanceSettings,
    });
    return res.status(200).json({ success: true, save: result });
  } catch (error) { next(error); }
});

router.get("/websites/:websiteId/revisions", async (req, res, next) => {
  try { return res.json({ success: true, revisions: await listRevisions(String(req.params.websiteId), userId(res), Number(req.query.limit || 30)) }); }
  catch (error) { next(error); }
});

router.get("/websites/:websiteId/revisions/:revision", async (req, res, next) => {
  try {
    const revision = Number(req.params.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new AppError("Invalid revision", 400, "INVALID_REVISION");
    return res.json({ success: true, revision: await getRevision(String(req.params.websiteId), userId(res), revision) });
  } catch (error) { next(error); }
});

router.post("/websites/:websiteId/publish", async (req, res, next) => {
  try {
    const release = await publishCurrentRevision(String(req.params.websiteId), userId(res), String(req.body?.requestKey || ""));
    return res.status(release.duplicate ? 200 : 201).json({ success: true, release });
  } catch (error) { next(error); }
});

router.get("/websites/:websiteId/releases", async (req, res, next) => {
  try { return res.json({ success: true, releases: await listReleases(String(req.params.websiteId), userId(res)) }); }
  catch (error) { next(error); }
});

router.post("/websites/:websiteId/releases/:releaseId/activate", async (req, res, next) => {
  try { return res.json({ success: true, release: await activateRelease(String(req.params.websiteId), userId(res), String(req.params.releaseId)) }); }
  catch (error) { next(error); }
});

export default router;
