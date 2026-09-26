import { supabaseAdmin } from '../lib/supabase.js';

export const OWNER_VERIFICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type OwnerVerificationStatus = (typeof OWNER_VERIFICATION_STATUSES)[number];

export interface VenueOwnerDetails {
    user_id: string;
    business_name: string;
    business_phone: string;
    gstin: string | null;
    payout_account: unknown | null;
    verification_status: OwnerVerificationStatus;
    rejection_reason: string | null;
    reviewed_by: string | null;
    reviewed_at: string | null;
    created_at: string;
    updated_at: string;
}

export type OwnerApplicationInput = Pick<VenueOwnerDetails, 'business_name' | 'business_phone' | 'gstin'>;

const TABLE = 'venue_owner_details';

export const findOwnerApplication = async (userId: string): Promise<VenueOwnerDetails | null> => {
    const { data, error } = await supabaseAdmin.from(TABLE).select('*').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data as VenueOwnerDetails | null;
};

// Creates a new application, or resubmits a rejected one
export const submitOwnerApplication = async (userId: string, input: OwnerApplicationInput): Promise<VenueOwnerDetails> => {
    const { data, error } = await supabaseAdmin
        .from(TABLE)
        .upsert({
            user_id: userId,
            ...input,
            verification_status: 'pending',
            rejection_reason: null,
            reviewed_by: null,
            reviewed_at: null,
        })
        .select('*')
        .single();
    if (error) throw error;
    return data as VenueOwnerDetails;
};

export const listOwnerApplications = async (status?: OwnerVerificationStatus) => {
    let query = supabaseAdmin
        .from(TABLE)
        .select('*, user:profiles!venue_owner_details_user_id_fkey(id, email, full_name, phone, city)')
        .order('created_at', { ascending: true });
    if (status) query = query.eq('verification_status', status);
    const { data, error } = await query;
    if (error) throw error;
    return data;
};

// Returns null when there is no pending application for the user
export const reviewOwnerApplication = async (
    userId: string,
    adminId: string,
    approve: boolean,
    reason?: string,
): Promise<VenueOwnerDetails | null> => {
    const { data, error } = await supabaseAdmin.rpc('review_venue_owner', {
        p_user_id: userId,
        p_admin_id: adminId,
        p_approve: approve,
        p_reason: reason ?? null,
    });
    if (error?.code === 'P0002') return null;
    if (error) throw error;
    return data as VenueOwnerDetails;
};
