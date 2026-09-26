import type { Request, Response } from 'express';
import type { Provider, Session } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { AUTH_STORAGE_KEY, createAuthClient, supabaseAdmin } from '../lib/supabase.js';
import {
    EDITABLE_PROFILE_FIELDS,
    getOrCreateProfile,
    updateProfile,
    type ProfileUpdate,
} from '../models/user.model.js';
import { getCookie } from '../utils/http.js';

const OAUTH_PROVIDERS: Provider[] = ['google'];
const PKCE_COOKIE = 'easyplay_pkce';
const PKCE_STORAGE_KEY = `${AUTH_STORAGE_KEY}-code-verifier`;

const PHONE_RE = /^\+[1-9]\d{7,14}$/; // E.164, e.g. +919876543210

const sessionResponse = async (session: Session) => ({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    user: await getOrCreateProfile(session.user),
});

// GET /auth/oauth/:provider
// Returns the provider URL. Open it in the browser (or pass ?redirect=true to be redirected directly).
export const startOAuth = async (req: Request, res: Response): Promise<void> => {
    const provider = req.params.provider as Provider;
    if (!OAUTH_PROVIDERS.includes(provider)) { res.status(400).json({ error: 'Unsupported provider' }); return; }

    const { client, store } = createAuthClient();
    const { data, error } = await client.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${env.apiUrl}/api/auth/oauth/callback`, skipBrowserRedirect: true },
    });
    if (error || !data.url) { res.status(400).json({ error: error?.message ?? 'Could not start OAuth' }); return; }

    // Keep the PKCE verifier in an httpOnly cookie so the callback can exchange the code
    const verifier = store[PKCE_STORAGE_KEY];
    if (verifier) {
        res.cookie(PKCE_COOKIE, verifier, {
            httpOnly: true,
            secure: env.isProd,
            sameSite: 'lax',
            maxAge: 10 * 60 * 1000,
            path: '/api/auth/oauth',
        });
    }

    if (req.query.redirect === 'true') { res.redirect(data.url); return; }
    res.status(200).json({ provider_url: data.url });
};

// GET /auth/oauth/callback?code=...
// Exchanges the code for a session and hands the tokens to the frontend in the URL fragment
export const oauthCallback = async (req: Request, res: Response): Promise<void> => {
    const fail = (reason: string) =>
        res.redirect(`${env.frontendUrl}/auth/callback#error=${encodeURIComponent(reason)}`);

    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const verifier = getCookie(req, PKCE_COOKIE);
    res.clearCookie(PKCE_COOKIE, { path: '/api/auth/oauth' });

    if (typeof req.query.error_description === 'string') { fail(req.query.error_description); return; }
    if (!code || !verifier) { fail('Missing OAuth code or session expired, please try again'); return; }

    const { client } = createAuthClient({ [PKCE_STORAGE_KEY]: verifier });
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    if (error || !data.session) { fail(error?.message ?? 'OAuth login failed'); return; }

    await getOrCreateProfile(data.session.user);
    const params = new URLSearchParams({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: String(data.session.expires_at ?? ''),
    });
    res.redirect(`${env.frontendUrl}/auth/callback#${params.toString()}`);
};

// POST /auth/refresh  { refresh_token }
export const refreshSession = async (req: Request, res: Response): Promise<void> => {
    const refreshToken = req.body?.refresh_token;
    if (typeof refreshToken !== 'string' || !refreshToken) {
        res.status(400).json({ error: 'refresh_token is required' });
        return;
    }

    const { client } = createAuthClient();
    const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) { res.status(401).json({ error: error?.message ?? 'Invalid refresh token' }); return; }
    res.status(200).json(await sessionResponse(data.session));
};

// POST /auth/logout  (auth required)  ?scope=global to log out of all devices
export const logout = async (req: Request, res: Response): Promise<void> => {
    const scope = req.query.scope === 'global' ? 'global' : 'local';
    const { error } = await supabaseAdmin.auth.admin.signOut(req.accessToken!, scope);
    if (error) { res.status(400).json({ error: error.message }); return; }
    res.status(200).json({ message: 'Logged out' });
};

// GET /auth/me  (auth required)
export const getMe = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ user: req.user });
};

// PATCH /auth/me  (auth required)  { full_name?, avatar_url?, city?, phone? }
export const updateMe = async (req: Request, res: Response): Promise<void> => {
    const changes: ProfileUpdate = {};
    for (const field of EDITABLE_PROFILE_FIELDS) {
        const value = req.body?.[field];
        if (value === undefined) continue;
        if (value !== null && typeof value !== 'string') {
            res.status(400).json({ error: `${field} must be a string or null` });
            return;
        }
        changes[field] = value === null ? null : value.trim();
    }
    if (changes.phone && !PHONE_RE.test(changes.phone)) {
        res.status(400).json({ error: 'Phone must be in E.164 format, e.g. +919876543210' });
        return;
    }
    if (Object.keys(changes).length === 0) { res.status(400).json({ error: 'No valid fields to update' }); return; }

    const user = await updateProfile(req.user!.id, changes);
    res.status(200).json({ user });
};
