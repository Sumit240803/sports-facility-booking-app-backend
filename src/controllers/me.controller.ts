import type { Request, Response } from 'express';
import { z } from 'zod';
import {
    cancelReminder,
    createReminder,
    listNotifications,
    listReminders,
    markAllRead,
    markRead,
    registerPushToken,
    removePushToken,
} from '../models/notification.model.js';
import { isoDate, pagination, parse, uuidParam } from '../utils/validate.js';

// ---------- Reminders ----------

export const reminderSchema = z.strictObject({
    court_id: z.uuid(),
    date: isoDate,
    slot_start: z.iso.datetime({ offset: true }),
});

// POST /me/reminders  { court_id, date, slot_start }  - slot must be listed but not bookable yet
export const addReminder = async (req: Request, res: Response): Promise<void> => {
    const input = parse(reminderSchema, req.body);
    const reminder = await createReminder(req.user!.id, input.court_id, input.date, new Date(input.slot_start).toISOString());
    res.status(201).json({ reminder });
};

const reminderListSchema = z.object({ status: z.enum(['pending', 'sent', 'cancelled']).optional() });

// GET /me/reminders?status=pending
export const getReminders = async (req: Request, res: Response): Promise<void> => {
    const { status } = parse(reminderListSchema, req.query);
    res.status(200).json({ reminders: await listReminders(req.user!.id, status) });
};

// DELETE /me/reminders/:id
export const deleteReminder = async (req: Request, res: Response): Promise<void> => {
    const ok = await cancelReminder(req.user!.id, uuidParam(req.params.id, 'reminder id'));
    if (!ok) { res.status(404).json({ error: 'Active reminder not found' }); return; }
    res.status(204).end();
};

// ---------- Notifications ----------

const notificationListSchema = z.object({
    unread: z.enum(['true', 'false']).optional(),
    ...pagination,
});

// GET /me/notifications?unread=true&page=&limit=
export const getNotifications = async (req: Request, res: Response): Promise<void> => {
    const q = parse(notificationListSchema, req.query);
    const result = await listNotifications(req.user!.id, q.unread === 'true', q.limit, (q.page - 1) * q.limit);
    res.status(200).json({ ...result, page: q.page, limit: q.limit });
};

// POST /me/notifications/:id/read
export const readNotification = async (req: Request, res: Response): Promise<void> => {
    const ok = await markRead(req.user!.id, uuidParam(req.params.id, 'notification id'));
    if (!ok) { res.status(404).json({ error: 'Notification not found' }); return; }
    res.status(204).end();
};

// POST /me/notifications/read-all
export const readAllNotifications = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ updated: await markAllRead(req.user!.id) });
};

// ---------- Push tokens ----------

export const pushTokenSchema = z.strictObject({
    token: z.string().trim().min(10).max(4096),
    platform: z.enum(['android', 'ios', 'web']),
});

// POST /me/push-tokens  { token, platform }  - call on every app start / token refresh
export const addPushToken = async (req: Request, res: Response): Promise<void> => {
    const { token, platform } = parse(pushTokenSchema, req.body);
    await registerPushToken(req.user!.id, token, platform);
    res.status(204).end();
};

export const removePushTokenSchema = z.strictObject({ token: z.string().trim().min(10).max(4096) });

// DELETE /me/push-tokens  { token }  - call on logout
export const deletePushToken = async (req: Request, res: Response): Promise<void> => {
    const { token } = parse(removePushTokenSchema, req.body);
    await removePushToken(req.user!.id, token);
    res.status(204).end();
};
