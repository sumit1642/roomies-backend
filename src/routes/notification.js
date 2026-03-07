// src/routes/notification.js
//
// All three routes require authentication — notifications are always personal.
// No role restriction: both students and PG owners receive notifications.
//
// Route order note: /unread-count and /mark-read are both static paths so
// there is no parameterised segment ambiguity to worry about here, unlike
// the connection and interest routers.

import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { getFeedSchema, markReadSchema } from "../validators/notification.validators.js";
import * as notificationController from "../controllers/notification.controller.js";

export const notificationRouter = Router();

// GET /api/v1/notifications
// Paginated notification feed. Optional isRead filter, keyset cursor pagination.
notificationRouter.get("/", authenticate, validate(getFeedSchema), notificationController.getFeed);

// GET /api/v1/notifications/unread-count
// Bell badge count — runs on every page load, covered by the partial index.
notificationRouter.get("/unread-count", authenticate, notificationController.getUnreadCount);

// POST /api/v1/notifications/mark-read
// Body: { all: true } or { notificationIds: [uuid, ...] }
notificationRouter.post("/mark-read", authenticate, validate(markReadSchema), notificationController.markRead);
