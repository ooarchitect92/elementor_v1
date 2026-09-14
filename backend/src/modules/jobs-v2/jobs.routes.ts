import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.middleware.js";
import { AppError } from "../../utils/app-error.js";
import { createPublishJob, getPublishJob, listPublishJobs } from "./jobs.service.js";

const router = Router();
router.use(requireAuth);

function currentUserId(res: Response): string {
  const id = res.locals.user?.id;
  if (!id) throw new AppError("Authentication required", 401, "AUTH_REQUIRED");
  return String(id);
}

router.post("/websites/:websiteId/publish-jobs", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestKey = String(req.header("Idempotency-Key") || req.body?.requestKey || "");
    const job = await createPublishJob(
      String(req.params.websiteId),
      currentUserId(res),
      requestKey,
      String(res.locals.requestId || ""),
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Location", `/api/v2/websites/${req.params.websiteId}/publish-jobs/${job.id}`);
    return res.status(job.replayed ? 200 : 202).json({ success: true, job });
  } catch (error) { next(error); }
});

router.get("/websites/:websiteId/publish-jobs", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobs = await listPublishJobs(
      String(req.params.websiteId),
      currentUserId(res),
      Number(req.query.limit || 30),
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ success: true, jobs });
  } catch (error) { next(error); }
});

router.get("/websites/:websiteId/publish-jobs/:jobId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await getPublishJob(
      String(req.params.websiteId),
      currentUserId(res),
      String(req.params.jobId),
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ success: true, job });
  } catch (error) { next(error); }
});

export default router;
