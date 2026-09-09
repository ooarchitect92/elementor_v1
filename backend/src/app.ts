import path from "path";
import express, { type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import passport from "./config/passport.js";

import {
  loginRoutes,
  signupRoutes,
  authRoutes,
  oauthRoutes,
  meRoutes,
  subscriptionRoutes,
  websiteRoutes,
  teamRoutes,
  uploadRoutes,
  apiKeysRoutes,
  developerRoutes,
  composerRoutes,
  customPostTypeRoutes,
  customCodeRoutes,
  pluginCompatRoutes,
  designNotesRoutes,
  componentAccessRoutes,
  templateRoutes,
  formRoutes,
  integrationRoutes
} from "./routes/index.js";
import coreV1Routes from "./modules/core-v1/core.routes.js";
import { errorMiddleware } from "./middlewares/error.middleware.js";
import { prisma } from "./config/prisma.js";
import { requestContext, liveness, readiness } from "./platform/health.js";

const app = express();
app.disable("x-powered-by");
app.use(requestContext);
app.get("/api/v1/health/live", liveness);
app.get("/api/v1/health/ready", readiness(() => prisma.$queryRaw`SELECT 1`));

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "5mb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.FORM_BODY_LIMIT || "1mb" }));
app.use(cookieParser());
app.use(passport.initialize());

app.get("/api/v1/health", (_req: Request, res: Response) => {
  res.status(200).json({ success: true, message: "API is healthy" });
});

// Core v2 product path. The public sub-route is deliberately mounted before its own auth gate.
app.use("/api/v2", coreV1Routes);

app.use("/api/v1/auth", loginRoutes);
app.use("/api/v1/auth", signupRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/v1/auth", oauthRoutes);
app.use("/api/v1/auth", meRoutes);

app.use("/api/v1/subscriptions", subscriptionRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/v1/websites", websiteRoutes);
app.use("/api/websites", websiteRoutes);
app.use("/api/v1/teams", teamRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/v1/uploads", uploadRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/v1/apikeys", apiKeysRoutes);
app.use("/api/apikeys", apiKeysRoutes);
app.use("/api/v1/developer", developerRoutes);
app.use("/api/developer", developerRoutes);
app.use("/api/v1/composer", composerRoutes);
app.use("/api/composer", composerRoutes);
app.use("/api/v1/cpt", customPostTypeRoutes);
app.use("/api/cpt", customPostTypeRoutes);
app.use("/api/v1/custom-code", customCodeRoutes);
app.use("/api/custom-code", customCodeRoutes);
app.use("/api/v1/design-notes", designNotesRoutes);
app.use("/api/design-notes", designNotesRoutes);
app.use("/api/v1/component-access", componentAccessRoutes);
app.use("/api/component-access", componentAccessRoutes);
app.use("/api/v1/templates", templateRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/v1/plugins", pluginCompatRoutes);
app.use("/api/plugins", pluginCompatRoutes);

// These existed in the route registry but were not mounted in the original app.
app.use("/api/v1/forms", formRoutes);
app.use("/api/forms", formRoutes);
app.use("/api/v1/integrations", integrationRoutes);
app.use("/api/integrations", integrationRoutes);

app.use(errorMiddleware);
export default app;
