// src/routes/index.js

import { Router } from "express";
import { healthRouter } from "./health.js";
import { authRouter } from "./auth.js";
import { studentRouter } from "./student.js";
import { pgOwnerRouter } from "./pgOwner.js";
import { propertyRouter } from "./property.js";
import { listingRouter } from "./listing.js";
import { interestRouter } from "./interest.js";
import { connectionRouter } from "./connection.js";
import { notificationRouter } from "./notification.js";
import { ratingRouter } from "./rating.js";
import { preferencesRouter } from "./preferences.js";
import { testUtilsRouter } from "./testUtils.js";
import { config } from "../config/env.js";
import { adminRouter } from "./admin.js";

// All feature routers are imported and mounted here as phases are built.
// Pattern: import → router.use('/path', featureRouter)

export const rootRouter = Router();

rootRouter.use("/health", healthRouter);
rootRouter.use("/auth", authRouter);
rootRouter.use("/students", studentRouter);
rootRouter.use("/pg-owners", pgOwnerRouter);
rootRouter.use("/admin", adminRouter);
rootRouter.use("/properties", propertyRouter);
rootRouter.use("/listings", listingRouter);
rootRouter.use("/interests", interestRouter);
rootRouter.use("/connections", connectionRouter);
rootRouter.use("/notifications", notificationRouter);
rootRouter.use("/ratings", ratingRouter);
rootRouter.use("/preferences", preferencesRouter);
if (config.NODE_ENV !== "production") {
	rootRouter.use("/test-utils", testUtilsRouter);
	// Log at startup so it's always visible in the terminal that this is active
	import("../logger/index.js").then(({ logger }) => {
		logger.warn("⚠️  Test utility routes are mounted — not for production use");
	});
}
