import type { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { getOrCreateProfile, type UserRole } from '../models/user.model.js';
import { findStaffRole, findVenueById, type VenueStaffRole } from '../models/venueStaff.model.js';
import { getBearerToken } from '../utils/http.js';
import { UUID_RE } from '../utils/validation.js';

// Verifies the Supabase access token and attaches the user's profile to req.user
export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = getBearerToken(req);
    if (!token) { res.status(401).json({ error: 'Missing access token' }); return; }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) { res.status(401).json({ error: 'Invalid or expired access token' }); return; }

    const profile = await getOrCreateProfile(data.user);
    if (profile.status === 'suspended') { res.status(403).json({ error: 'Account suspended' }); return; }

    req.user = profile;
    req.accessToken = token;
    next();
};

// For public endpoints that personalise when logged in: sets req.user if a valid token is sent
export const optionalAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = getBearerToken(req);
    if (token) {
        const { data } = await supabaseAdmin.auth.getUser(token);
        if (data.user) {
            const profile = await getOrCreateProfile(data.user);
            if (profile.status === 'active') req.user = profile;
        }
    }
    next();
};

// Use after requireAuth: requireRole('venue_owner', 'admin')
export const requireRole = (...roles: UserRole[]) =>
    (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
        if (!roles.includes(req.user.role)) { res.status(403).json({ error: 'Forbidden' }); return; }
        next();
    };

// Use after requireAuth on routes with :venueId.
// The venue's owner and admins always pass; staff pass only with one of the given roles.
//   requireVenueAccess()                     -> owner/admin only
//   requireVenueAccess('manager')            -> + managers
//   requireVenueAccess('manager', 'staff')   -> + all staff
export const requireVenueAccess = (...staffRoles: VenueStaffRole[]) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const user = req.user;
        if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }

        const venueId = req.params.venueId;
        if (typeof venueId !== 'string' || !UUID_RE.test(venueId)) { res.status(400).json({ error: 'Invalid venue id' }); return; }

        const venue = await findVenueById(venueId);
        if (!venue) { res.status(404).json({ error: 'Venue not found' }); return; }

        if (user.role === 'admin') {
            req.venueAccess = { venue, role: 'admin' };
            next();
            return;
        }
        // An owner who has been demoted loses management access to their venues
        if (venue.owner_id === user.id && user.role === 'venue_owner') {
            req.venueAccess = { venue, role: 'owner' };
            next();
            return;
        }

        const staffRole = await findStaffRole(venueId, user.id);
        if (!staffRole || !staffRoles.includes(staffRole)) { res.status(403).json({ error: 'Forbidden' }); return; }

        req.venueAccess = { venue, role: staffRole };
        next();
    };
