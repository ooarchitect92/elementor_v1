import type { Request, Response, NextFunction } from "express";
import {
  processFormSubmission,
  getWebsiteSubmissions,
  deleteWebsiteSubmission,
} from "../services/form/form.service.js";

/** POST /api/forms/submit - public durable form acceptance. */
export async function submitFormHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { websiteId, formId, formName, fields, actions, spamProtection, honeypotValue } = req.body;
    const header = req.headers["idempotency-key"];
    const requestKey = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
    const metadata = {
      // req.ip is authoritative only when Express trust-proxy is explicitly configured.
      ip: req.ip || req.socket.remoteAddress || "unknown",
      userAgent: req.headers["user-agent"] || "unknown",
      referer: req.headers.referer || "",
    };
    const result = await processFormSubmission({
      websiteId,
      formId,
      formName,
      fields,
      // Kept for wire compatibility; the service ignores client delivery destinations and
      // resolves all actions from the encrypted ACTIVE release.
      actions,
      spamProtection,
      honeypotValue,
      requestKey,
      requestId: res.locals.requestId,
      metadata,
    });
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/** GET /api/forms/:websiteId/submissions */
export async function getWebsiteSubmissionsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const submissions = await getWebsiteSubmissions(req.params.websiteId as string, res.locals.user.id);
    return res.status(200).json({ success: true, submissions });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/forms/:websiteId/submissions/:submissionId */
export async function deleteSubmissionHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await deleteWebsiteSubmission(
      req.params.websiteId as string,
      req.params.submissionId as string,
      res.locals.user.id,
    );
    return res.status(200).json({ success: true, message: "Submission deleted successfully" });
  } catch (error) {
    next(error);
  }
}

/** GET /api/forms/:websiteId/export */
export async function exportSubmissionsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const websiteId = req.params.websiteId as string;
    const format = (req.query.format as string) || "json";
    const submissions = await getWebsiteSubmissions(websiteId, res.locals.user.id);
    if (format === "csv") {
      if (submissions.length === 0) {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=submissions-${websiteId}.csv`);
        return res.status(200).send("id,formId,formName,submittedAt,data\n");
      }
      const allKeys = new Set<string>();
      submissions.forEach((submission) => {
        if (submission.data && typeof submission.data === "object") {
          Object.keys(submission.data).forEach((key) => allKeys.add(key));
        }
      });
      const keys = Array.from(allKeys);
      const headerRow = ["ID", "Form Name", "Submitted At", ...keys].join(",");
      const rows = submissions.map((submission) => {
        const values = keys.map((key) => {
          const value = submission.data?.[key] !== undefined
            ? String(submission.data[key]).replace(/"/g, '""')
            : "";
          return `"${value}"`;
        });
        return [
          `"${submission.id}"`,
          `"${submission.formName || ""}"`,
          `"${submission.createdAt ? new Date(submission.createdAt).toISOString() : ""}"`,
          ...values,
        ].join(",");
      });
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=submissions-${websiteId}.csv`);
      return res.status(200).send([headerRow, ...rows].join("\n"));
    }
    return res.status(200).json({ success: true, submissions });
  } catch (error) {
    next(error);
  }
}
