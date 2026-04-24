








import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { getFeedSchema, markReadSchema } from "../validators/notification.validators.js";
import * as notificationController from "../controllers/notification.controller.js";

export const notificationRouter = Router();



notificationRouter.get("/", authenticate, validate(getFeedSchema), notificationController.getFeed);



notificationRouter.get("/unread-count", authenticate, notificationController.getUnreadCount);



notificationRouter.post("/mark-read", authenticate, validate(markReadSchema), notificationController.markRead);
