import { Router } from "express";
import { healthRouter } from "./health.js";

// All feature routers are imported and mounted here as phases are built.
// Pattern: import → router.use('/path', featureRouter)

export const rootRouter = Router();

rootRouter.use("/health", healthRouter);
