import { supabaseAdmin } from '../lib/supabase.js';

export const VENUE_STAFF_ROLES = ['manager', 'staff'] as const;
export type VenueStaffRole = (typeof VENUE_STAFF_ROLES)[number];

export interface Venue {
    id: string;
    owner_id: string;
    name: string;
    status: 'draft' | 'pending_review' | 'live' | 'rejected' | 'suspended';
}

export const findVenueById = async (id: string): Promise<Venue | null> => {
    const { data, error } = await supabaseAdmin.from('venues').select('id, owner_id, name, status').eq('id', id).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    return data as Venue | null;
};

export const findStaffRole = async (venueId: string, userId: string): Promise<VenueStaffRole | null> => {
    const { data, error } = await supabaseAdmin
        .from('venue_staff')
        .select('role')
        .eq('venue_id', venueId)
        .eq('user_id', userId)
        .maybeSingle();
    if (error) throw error;
    return (data?.role as VenueStaffRole | undefined) ?? null;
};

export const listVenueStaff = async (venueId: string) => {
    const [members, invites] = await Promise.all([
        supabaseAdmin
            .from('venue_staff')
            .select('role, created_at, user:profiles!venue_staff_user_id_fkey(id, email, full_name, phone, avatar_url)')
            .eq('venue_id', venueId)
            .order('created_at'),
        supabaseAdmin
            .from('venue_staff_invites')
            .select('email, role, created_at')
            .eq('venue_id', venueId)
            .order('created_at'),
    ]);
    if (members.error) throw members.error;
    if (invites.error) throw invites.error;
    return { members: members.data, pending_invites: invites.data };
};

export const upsertStaffMember = async (venueId: string, userId: string, role: VenueStaffRole, invitedBy: string) => {
    const { data, error } = await supabaseAdmin
        .from('venue_staff')
        .upsert({ venue_id: venueId, user_id: userId, role, invited_by: invitedBy })
        .select('*')
        .single();
    if (error) throw error;
    return data;
};

export const upsertStaffInvite = async (venueId: string, email: string, role: VenueStaffRole, invitedBy: string) => {
    const { data, error } = await supabaseAdmin
        .from('venue_staff_invites')
        .upsert({ venue_id: venueId, email: email.toLowerCase(), role, invited_by: invitedBy })
        .select('*')
        .single();
    if (error) throw error;
    return data;
};

export const updateStaffRole = async (venueId: string, userId: string, role: VenueStaffRole) => {
    const { data, error } = await supabaseAdmin
        .from('venue_staff')
        .update({ role })
        .eq('venue_id', venueId)
        .eq('user_id', userId)
        .select('*')
        .maybeSingle();
    if (error) throw error;
    return data;
};

// Returns true if a row was deleted
export const removeStaffMember = async (venueId: string, userId: string): Promise<boolean> => {
    const { data, error } = await supabaseAdmin
        .from('venue_staff')
        .delete()
        .eq('venue_id', venueId)
        .eq('user_id', userId)
        .select('user_id');
    if (error) throw error;
    return data.length > 0;
};

export const removeStaffInvite = async (venueId: string, email: string): Promise<boolean> => {
    const { data, error } = await supabaseAdmin
        .from('venue_staff_invites')
        .delete()
        .eq('venue_id', venueId)
        .eq('email', email.toLowerCase())
        .select('email');
    if (error) throw error;
    return data.length > 0;
};
