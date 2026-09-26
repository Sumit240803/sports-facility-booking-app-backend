import { supabaseAdmin } from '../lib/supabase.js';
import type { User } from '@supabase/supabase-js';

export const USER_ROLES = ['player', 'venue_owner', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface Profile {
    id: string;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    avatar_url: string | null;
    city: string | null;
    role: UserRole;
    created_at: string;
    updated_at: string;
}

// Fields a user may change on their own profile (role is deliberately excluded)
export const EDITABLE_PROFILE_FIELDS = ['full_name', 'avatar_url', 'city', 'phone'] as const;
export type ProfileUpdate = Partial<Pick<Profile, (typeof EDITABLE_PROFILE_FIELDS)[number]>>;

const TABLE = 'profiles';

export const findProfileById = async (id: string): Promise<Profile | null> => {
    const { data, error } = await supabaseAdmin.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data as Profile | null;
};

// The DB trigger normally creates the profile on sign-up; this is a fallback
// for users created before the trigger existed.
export const getOrCreateProfile = async (user: User): Promise<Profile> => {
    const existing = await findProfileById(user.id);
    if (existing) return existing;

    const meta = user.user_metadata ?? {};
    const { data, error } = await supabaseAdmin
        .from(TABLE)
        .upsert({
            id: user.id,
            email: user.email ?? null,
            phone: user.phone || null,
            full_name: meta.full_name ?? meta.name ?? null,
            avatar_url: meta.avatar_url ?? meta.picture ?? null,
        })
        .select('*')
        .single();
    if (error) throw error;
    return data as Profile;
};

export const updateProfile = async (id: string, changes: ProfileUpdate): Promise<Profile> => {
    const { data, error } = await supabaseAdmin
        .from(TABLE)
        .update({ ...changes, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .single();
    if (error) throw error;
    return data as Profile;
};
