import type { Request, Response } from 'express';
import { findProfileByEmail } from '../models/user.model.js';
import {
    listVenueStaff,
    removeStaffInvite,
    removeStaffMember,
    updateStaffRole,
    upsertStaffInvite,
    upsertStaffMember,
    VENUE_STAFF_ROLES,
    type VenueStaffRole,
} from '../models/venueStaff.model.js';
import { EMAIL_RE, readString, UUID_RE } from '../utils/validation.js';

const readRole = (value: unknown): VenueStaffRole | null =>
    VENUE_STAFF_ROLES.includes(value as VenueStaffRole) ? (value as VenueStaffRole) : null;

// GET /venues/:venueId/staff
export const listStaff = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json(await listVenueStaff(req.venueAccess!.venue.id));
};

// POST /venues/:venueId/staff  { email, role? }
// Adds the user directly if they have an account, otherwise stores an invite
// that is claimed automatically when they first sign in with that email.
export const inviteStaff = async (req: Request, res: Response): Promise<void> => {
    const venue = req.venueAccess!.venue;
    const email = readString(req.body?.email)?.toLowerCase();
    const role = req.body?.role === undefined ? 'staff' : readRole(req.body.role);

    if (!email || !EMAIL_RE.test(email)) { res.status(400).json({ error: 'A valid email is required' }); return; }
    if (!role) { res.status(400).json({ error: `role must be one of ${VENUE_STAFF_ROLES.join(', ')}` }); return; }

    const profile = await findProfileByEmail(email);
    if (profile?.id === venue.owner_id) { res.status(400).json({ error: 'The owner cannot be added as staff' }); return; }
    if (profile?.status === 'suspended') { res.status(400).json({ error: 'This user is suspended' }); return; }

    if (profile) {
        const member = await upsertStaffMember(venue.id, profile.id, role, req.user!.id);
        res.status(201).json({ member, invited: false });
        return;
    }
    const invite = await upsertStaffInvite(venue.id, email, role, req.user!.id);
    res.status(201).json({ invite, invited: true });
};

// PATCH /venues/:venueId/staff/:userId  { role }
export const changeStaffRole = async (req: Request, res: Response): Promise<void> => {
    const userId = req.params.userId;
    const role = readRole(req.body?.role);
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) { res.status(400).json({ error: 'Invalid user id' }); return; }
    if (!role) { res.status(400).json({ error: `role must be one of ${VENUE_STAFF_ROLES.join(', ')}` }); return; }

    const member = await updateStaffRole(req.venueAccess!.venue.id, userId, role);
    if (!member) { res.status(404).json({ error: 'Staff member not found' }); return; }
    res.status(200).json({ member });
};

// DELETE /venues/:venueId/staff/:userId
export const removeStaff = async (req: Request, res: Response): Promise<void> => {
    const userId = req.params.userId;
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) { res.status(400).json({ error: 'Invalid user id' }); return; }

    const removed = await removeStaffMember(req.venueAccess!.venue.id, userId);
    if (!removed) { res.status(404).json({ error: 'Staff member not found' }); return; }
    res.status(204).end();
};

// DELETE /venues/:venueId/staff/invites/:email
export const cancelInvite = async (req: Request, res: Response): Promise<void> => {
    const email = typeof req.params.email === 'string' ? req.params.email : '';
    const removed = await removeStaffInvite(req.venueAccess!.venue.id, email);
    if (!removed) { res.status(404).json({ error: 'Invite not found' }); return; }
    res.status(204).end();
};
