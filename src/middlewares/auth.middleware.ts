import type { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { getOrCreateProfile, type UserRole } from '../models/user.model.js';
import { getBearerToken } from '../utils/http.js';

// Verifies the Supabase access token and attaches the user's profile to req.user
export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = getBearerToken(req);
    if (!token) { res.status(401).json({ error: 'Missing access token' }); return; }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) { res.status(401).json({ error: 'Invalid or expired access token' }); return; }

    req.user = await getOrCreateProfile(data.user);
    req.accessToken = token;
    next();
};

// Use after requireAuth: requireRole('venue_owner', 'admin')
export const requireRole = (...roles: UserRole[]) =>
    (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
        if (!roles.includes(req.user.role)) { res.status(403).json({ error: 'Forbidden' }); return; }
        next();
    };
