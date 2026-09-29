import { supabaseAdmin } from '../lib/supabase.js';
import type { User } from '@supabase/supabase-js';

export const USER_ROLES = ['player', 'venue_owner', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface Profile {
    id: string;
    email: string | null;
    full_name: string | null;
    avatar_url: string | null;
    phone: string | null;
    phone_verified: boolean;
    city: string | null;
    preferred_sports: string[];
    role: UserRole;
    status: UserStatus;
    onboarded_at: string | null;
    last_login_at: string | null;
    notify_email: boolean;
    notify_push: boolean;
    created_at: string;
    updated_at: string;
}

// Fields a user may change on their own profile (role/status are admin-only)
export type ProfileUpdate = Partial<Pick<Profile, 'full_name' | 'avatar_url' | 'city' | 'phone' | 'preferred_sports' | 'notify_email' | 'notify_push'>>;
export type AdminProfileUpdate = Partial<Pick<Profile, 'role' | 'status'>>;

const TABLE = 'profiles';

export const findProfileById = async (id: string): Promise<Profile | null> => {
    const { data, error } = await supabaseAdmin.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data as Profile | null;
};

export const findProfileByEmail = async (email: string): Promise<Profile | null> => {
    const { data, error } = await supabaseAdmin.from(TABLE).select('*').eq('email', email.toLowerCase()).maybeSingle();
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
            email: user.email?.toLowerCase() ?? null,
            full_name: meta.full_name ?? meta.name ?? null,
            avatar_url: meta.avatar_url ?? meta.picture ?? null,
        })
        .select('*')
        .single();
    if (error) throw error;
    return data as Profile;
};

export const updateProfile = async (
    id: string,
    changes: ProfileUpdate | AdminProfileUpdate | { onboarded_at?: string; last_login_at?: string },
): Promise<Profile> => {
    const { data, error } = await supabaseAdmin.from(TABLE).update(changes).eq('id', id).select('*').single();
    if (error) throw error;
    return data as Profile;
};

// Onboarding is complete once the user has given name, phone and city
export const isOnboardingComplete = (p: Pick<Profile, 'full_name' | 'phone' | 'city'>): boolean =>
    Boolean(p.full_name && p.phone && p.city);

// Admin: search users by email, name or phone (newest first)
export const listUsers = async (
    filters: { q?: string | undefined; role?: UserRole | undefined; status?: UserStatus | undefined },
    limit: number,
    offset: number,
) => {
    let query = supabaseAdmin
        .from(TABLE)
        .select('id, email, full_name, avatar_url, phone, city, role, status, onboarded_at, last_login_at, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    // q is already LIKE-escaped and stripped of PostgREST filter syntax by the controller
    if (filters.q) query = query.or(`email.ilike.%${filters.q}%,full_name.ilike.%${filters.q}%,phone.ilike.%${filters.q}%`);
    if (filters.role) query = query.eq('role', filters.role);
    if (filters.status) query = query.eq('status', filters.status);
    const { data, error, count } = await query;
    if (error) throw error;
    return { users: data, total: count ?? 0 };
};
