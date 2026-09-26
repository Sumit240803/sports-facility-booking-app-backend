import type { Request, Response } from 'express';
import {
    findProfileById,
    updateProfile,
    USER_ROLES,
    USER_STATUSES,
    type AdminProfileUpdate,
    type UserRole,
    type UserStatus,
} from '../models/user.model.js';
import { UUID_RE } from '../utils/validation.js';

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
