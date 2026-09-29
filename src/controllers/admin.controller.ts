import type { Request, Response } from 'express';
import { z } from 'zod';
import {
    findProfileById,
    listUsers,
    updateProfile,
    USER_ROLES,
    USER_STATUSES,
    type AdminProfileUpdate,
    type UserRole,
    type UserStatus,
} from '../models/user.model.js';
import { UUID_RE } from '../utils/validation.js';
import { escapeLike, pagination, parse } from '../utils/validate.js';

const listUsersSchema = z.object({
    // Commas and parentheses would break the PostgREST or() filter; they never occur in emails/names/phones we match
    q: z.string().trim().max(80).transform((s) => escapeLike(s.replace(/[,()]/g, ' ').trim())).optional(),
    role: z.enum(USER_ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
    ...pagination,
});

// GET /admin/users?q=&role=&status=&page=&limit=
export const listUsersHandler = async (req: Request, res: Response): Promise<void> => {
    const p = parse(listUsersSchema, req.query);
    const { users, total } = await listUsers({ q: p.q || undefined, role: p.role, status: p.status }, p.limit, (p.page - 1) * p.limit);
    res.status(200).json({ users, page: p.page, limit: p.limit, total });
};

// PATCH /admin/users/:userId  { role?, status? }
export const updateUser = async (req: Request, res: Response): Promise<void> => {
    const userId = req.params.userId;
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) { res.status(400).json({ error: 'Invalid user id' }); return; }
    if (userId === req.user!.id) { res.status(400).json({ error: 'You cannot change your own role or status' }); return; }

    const { role, status } = req.body ?? {};
    const changes: AdminProfileUpdate = {};
    if (role !== undefined) {
        if (!USER_ROLES.includes(role)) { res.status(400).json({ error: `role must be one of ${USER_ROLES.join(', ')}` }); return; }
        changes.role = role as UserRole;
    }
    if (status !== undefined) {
        if (!USER_STATUSES.includes(status)) { res.status(400).json({ error: `status must be one of ${USER_STATUSES.join(', ')}` }); return; }
        changes.status = status as UserStatus;
    }
    if (Object.keys(changes).length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }

    if (!(await findProfileById(userId))) { res.status(404).json({ error: 'User not found' }); return; }
    const user = await updateProfile(userId, changes);
    res.status(200).json({ user });
};
