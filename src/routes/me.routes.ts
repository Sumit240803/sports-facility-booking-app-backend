import express from 'express';
import * as meController from '../controllers/me.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

// Current user's reminders, notifications and devices
const router = express.Router();

router.use(requireAuth);

router.get('/reminders', meController.getReminders);
router.post('/reminders', meController.addReminder);
router.delete('/reminders/:id', meController.deleteReminder);

router.get('/notifications', meController.getNotifications);
router.post('/notifications/read-all', meController.readAllNotifications);
router.post('/notifications/:id/read', meController.readNotification);

router.post('/push-tokens', meController.addPushToken);
router.delete('/push-tokens', meController.deletePushToken);

export default router;
