import type { Request, Response } from 'express';
import type { Provider, Session } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { AUTH_STORAGE_KEY, createAuthClient, supabaseAdmin } from '../lib/supabase.js';
import {
    getOrCreateProfile,
    isOnboardingComplete,
    updateProfile,
    type ProfileUpdate,
} from '../models/user.model.js';
import { getCookie } from '../utils/http.js';
import { normalizePhone, PHONE_ERROR, PHONE_RE } from '../utils/validation.js';

const OAUTH_PROVIDERS: Provider[] = ['google'];
const PKCE_COOKIE = 'easyplay_pkce';
const PKCE_STORAGE_KEY = `${AUTH_STORAGE_KEY}-code-verifier`;

const MAX_PREFERRED_SPORTS = 10;

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

    const profile = await getOrCreateProfile(data.session.user);
    if (profile.status === 'suspended') {
        await supabaseAdmin.auth.admin.signOut(data.session.access_token, 'global');
        fail('Account suspended');
        return;
    }
    await updateProfile(profile.id, { last_login_at: new Date().toISOString() });

    const params = new URLSearchParams({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: String(data.session.expires_at ?? ''),
    });
    res.redirect(`${env.frontendUrl}/auth/callback#${params.toString()}`);
};

// GET /auth/google/config
// What the mobile app needs to start native Google Sign-In
export const googleConfig = async (_req: Request, res: Response): Promise<void> => {
    if (!env.googleWebClientId) { res.status(503).json({ error: 'Google sign-in is not configured' }); return; }
    res.status(200).json({ web_client_id: env.googleWebClientId });
};

// POST /auth/google/token  { id_token, nonce? }
// Native sign-in: the app gets a Google ID token from the OS account picker; Supabase verifies it
// (audience, signature, nonce) and creates/returns the session. No browser, cookies or redirects.
export const googleIdTokenSignIn = async (req: Request, res: Response): Promise<void> => {
    const idToken = req.body?.id_token;
    const nonce = req.body?.nonce;
    if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 8192) {
        res.status(400).json({ error: 'id_token is required' });
        return;
    }
    if (nonce !== undefined && (typeof nonce !== 'string' || nonce.length > 256)) {
        res.status(400).json({ error: 'Invalid nonce' });
        return;
    }

    const { client } = createAuthClient();
    const { data, error } = await client.auth.signInWithIdToken({
        provider: 'google',
        token: idToken,
        ...(nonce ? { nonce } : {}),
    });
    if (error || !data.session) { res.status(401).json({ error: error?.message ?? 'Google sign-in failed' }); return; }

    const profile = await getOrCreateProfile(data.session.user);
    if (profile.status === 'suspended') {
        await supabaseAdmin.auth.admin.signOut(data.session.access_token, 'global');
        res.status(403).json({ error: 'Account suspended' });
        return;
    }
    await updateProfile(profile.id, { last_login_at: new Date().toISOString() });
    res.status(200).json(await sessionResponse(data.session));
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

// PATCH /auth/me  (auth required)
// { full_name?, avatar_url?, city?, phone?, preferred_sports?, notify_email?, notify_push? }
// onboarded_at is set automatically once full_name, phone and city are all present.
export const updateMe = async (req: Request, res: Response): Promise<void> => {
    const body = req.body ?? {};
    const changes: ProfileUpdate = {};

    for (const field of ['full_name', 'avatar_url', 'city'] as const) {
        const value = body[field];
        if (value === undefined) continue;
        if (value !== null && typeof value !== 'string') {
            res.status(400).json({ error: `${field} must be a string or null` });
            return;
        }
        changes[field] = value?.trim() || null;
    }

    if (body.phone !== undefined) {
        if (typeof body.phone !== 'string' || !PHONE_RE.test(normalizePhone(body.phone))) {
            res.status(400).json({ error: PHONE_ERROR });
            return;
        }
        changes.phone = normalizePhone(body.phone);
    }

    if (body.preferred_sports !== undefined) {
        const sports = body.preferred_sports;
        if (!Array.isArray(sports) || sports.some((s) => typeof s !== 'string' || !s.trim())) {
            res.status(400).json({ error: 'preferred_sports must be an array of strings' });
            return;
        }
        const unique = [...new Set(sports.map((s: string) => s.trim().toLowerCase()))];
        if (unique.length > MAX_PREFERRED_SPORTS) {
            res.status(400).json({ error: `At most ${MAX_PREFERRED_SPORTS} preferred sports allowed` });
            return;
        }
        changes.preferred_sports = unique;
    }

    for (const field of ['notify_email', 'notify_push'] as const) {
        if (body[field] === undefined) continue;
        if (typeof body[field] !== 'boolean') { res.status(400).json({ error: `${field} must be a boolean` }); return; }
        changes[field] = body[field];
    }

    if (Object.keys(changes).length === 0) { res.status(400).json({ error: 'No valid fields to update' }); return; }

    const current = req.user!;
    const onboarding = !current.onboarded_at && isOnboardingComplete({ ...current, ...changes })
        ? { onboarded_at: new Date().toISOString() }
        : {};

    const user = await updateProfile(current.id, { ...changes, ...onboarding });
    res.status(200).json({ user });
};
