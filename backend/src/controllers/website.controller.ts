import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import {
  getUserWebsites,
  getWebsiteById,
  createWebsite,
  deleteWebsite,
} from "../services/website.service.js";
import { getEditorState, saveEditorRevision } from "../modules/core-v1/core.service.js";

export async function getWebsitesHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const websites = await getUserWebsites(res.locals.user.id);
    return res.status(200).json({ success: true, websites });
  } catch (error) { next(error); }
}

export async function getWebsiteByIdHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const website = await getWebsiteById(req.params.id as string, res.locals.user.id);
    return res.status(200).json({ success: true, website });
  } catch (error) { next(error); }
}

export async function createWebsiteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const website = await createWebsite(res.locals.user.id, req.body.name);
    return res.status(201).json({ success: true, message: "Website created successfully", website });
  } catch (error) { next(error); }
}

/**
 * Legacy PUT compatibility path. It now participates in the same revision transaction as
 * autosave, so a manual Save can never mutate editor state outside the durable ledger.
 */
export async function updateWebsiteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = res.locals.user.id;
    const websiteId = req.params.id as string;
    const state = await getEditorState(websiteId, userId);
    const save = await saveEditorRevision(websiteId, userId, {
      expectedRevision: Number(state.currentRevision),
      requestKey: `legacy:${websiteId}:${crypto.randomUUID()}`,
      editorData: req.body?.editorData || {},
      performanceSettings: req.body?.performanceSettings,
    });
    const website = await getWebsiteById(websiteId, userId);
    return res.status(200).json({ success: true, message: "Website saved successfully", website, save });
  } catch (error) { next(error); }
}

export async function deleteWebsiteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await deleteWebsite(req.params.id as string, res.locals.user.id);
    return res.status(200).json({ success: true, message: "Website deleted successfully" });
  } catch (error) { next(error); }
}

export async function getWebsiteRolesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { getWebsiteRoles } = await import("../services/website.service.js");
    const roles = await getWebsiteRoles(req.params.id as string, res.locals.user.id);
    return res.status(200).json({ success: true, roles });
  } catch (error) { next(error); }
}

export async function updateWebsiteRoleHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { updateWebsiteRole } = await import("../services/website.service.js");
    await updateWebsiteRole(req.params.id as string, res.locals.user.id, req.params.collaboratorUserId as string, req.body.role);
    return res.status(200).json({ success: true, message: "Role updated successfully" });
  } catch (error) { next(error); }
}

export async function inviteWebsiteMemberHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, role } = req.body;
    const { inviteWebsiteMember } = await import("../services/website.service.js");
    const result = await inviteWebsiteMember(req.params.id as string, res.locals.user.id, email, role);
    return res.status(200).json({ success: true, ...result });
  } catch (error) { next(error); }
}

export async function acceptWebsiteInvitationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { acceptWebsiteInvitation } = await import("../services/website.service.js");
    const result = await acceptWebsiteInvitation(req.body.token, res.locals.user.id);
    return res.status(200).json({ ...result, success: true });
  } catch (error) { next(error); }
}

export async function removeWebsiteMemberHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { removeWebsiteMember } = await import("../services/website.service.js");
    await removeWebsiteMember(req.params.id as string, res.locals.user.id, req.params.collaboratorUserId as string);
    return res.status(200).json({ success: true, message: "Member removed" });
  } catch (error) { next(error); }
}

export async function getGranularPermissionsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { getGranularPermissions } = await import("../services/permission.service.js");
    const result = await getGranularPermissions(req.params.id as string, res.locals.user.id);
    return res.status(200).json({ success: true, permissions: result });
  } catch (error) { next(error); }
}

export async function setGranularPermissionHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { targetUserId, resourceId, capability, effect } = req.body;
    const { setGranularPermission } = await import("../services/permission.service.js");
    const result = await setGranularPermission(req.params.id as string, res.locals.user.id, targetUserId, resourceId, capability, effect);
    return res.status(200).json({ ...result, success: true });
  } catch (error) { next(error); }
}
