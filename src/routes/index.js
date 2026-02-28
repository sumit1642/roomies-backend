// src/routes/index.js

import { Router } from "express";
import { healthRouter } from "./health.js";
import { authRouter } from "./auth.js";
import { studentRouter } from "./student.js";
import { pgOwnerRouter } from "./pgOwner.js";

// All feature routers are imported and mounted here as phases are built.
// Pattern: import → router.use('/path', featureRouter)

export const rootRouter = Router();

rootRouter.use("/health", healthRouter);
rootRouter.use("/auth", authRouter);
rootRouter.use("/students", studentRouter);
rootRouter.use("/pg-owners", pgOwnerRouter);
