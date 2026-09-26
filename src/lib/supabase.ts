import { createClient, type SupportedStorage } from '@supabase/supabase-js';
import { env } from '../config/env.js';

export const AUTH_STORAGE_KEY = 'easyplay-auth';

// Service-role client for trusted server-side work (profiles, admin auth calls).
// Never expose this key to clients.
export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
});

// A fresh anon client per auth operation, so one user's session never leaks
// into another request through a shared in-memory client.
export const createAuthClient = (storage?: Record<string, string>) => {
    const store = storage ?? {};
    const memoryStorage: SupportedStorage = {
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => { store[key] = value; },
        removeItem: (key) => { delete store[key]; },
    };

    const client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
        auth: {
            flowType: 'pkce',
            storageKey: AUTH_STORAGE_KEY,
            storage: memoryStorage,
            persistSession: true, // stored only in the per-request memory store above
            autoRefreshToken: false,
            detectSessionInUrl: false,
        },
    });

    return { client, store };
};
