import { supabaseAdmin } from '../lib/supabase.js';
import { thumbUrl } from './venue.model.js';

// ---------- Reviews ----------

const REVIEW_COLUMNS = 'id, venue_id, rating, comment, owner_reply, owner_replied_at, created_at, updated_at';

export const submitReview = async (userId: string, venueId: string, rating: number, comment: string | null) => {
    const { data, error } = await supabaseAdmin.rpc('submit_review', { p_user_id: userId, p_venue_id: venueId, p_rating: rating, p_comment: comment });
    if (error) throw error;
    return data as Record<string, unknown>;
};

export const deleteOwnReview = async (userId: string, venueId: string): Promise<boolean> => {
    const { data, error } = await supabaseAdmin.from('reviews').delete().eq('user_id', userId).eq('venue_id', venueId).select('id');
    if (error) throw error;
    return data.length > 0;
};

export const listMyReviews = async (userId: string) => {
    const { data, error } = await supabaseAdmin
        .from('reviews')
        .select(`${REVIEW_COLUMNS}, status, venue:venues(id, name, slug, city)`)
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(200);
    if (error) throw error;
    return data;
};

export type ReviewSort = 'newest' | 'highest' | 'lowest';

// Public: visible reviews with the reviewer's first name only
export const listVenueReviews = async (venueId: string, sort: ReviewSort, limit: number, offset: number, includeHidden = false) => {
    let query = supabaseAdmin
        .from('reviews')
        .select(`${REVIEW_COLUMNS}, status, hidden_reason, author:profiles!reviews_user_id_fkey(full_name, avatar_url)`, { count: 'exact' })
        .eq('venue_id', venueId)
        .range(offset, offset + limit - 1);
    if (!includeHidden) query = query.eq('status', 'visible');
    query = sort === 'highest'
        ? query.order('rating', { ascending: false }).order('created_at', { ascending: false })
        : sort === 'lowest'
            ? query.order('rating', { ascending: true }).order('created_at', { ascending: false })
            : query.order('created_at', { ascending: false });
    const { data, error, count } = await query;
    if (error) throw error;
    const reviews = (data as unknown as Array<Record<string, unknown> & { author: { full_name: string | null; avatar_url: string | null } | null; status: string; hidden_reason: string | null }>)
        .map(({ author, status, hidden_reason, ...r }) => ({
            ...r,
            ...(includeHidden ? { status, hidden_reason } : {}),
            // Privacy: first name only
            author: { name: author?.full_name?.trim().split(/\s+/)[0] ?? 'Player', avatar_url: author?.avatar_url ?? null },
        }));
    return { reviews, total: count ?? 0 };
};

export const ratingBreakdown = async (venueId: string) => {
    const { data, error } = await supabaseAdmin.from('reviews').select('rating').eq('venue_id', venueId).eq('status', 'visible');
    if (error) throw error;
    const breakdown: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of data as { rating: number }[]) breakdown[r.rating] = (breakdown[r.rating] ?? 0) + 1;
    return breakdown;
};

export const findReview = async (venueId: string, reviewId: string) => {
    const { data, error } = await supabaseAdmin.from('reviews').select('id, user_id, venue_id, status, rating').eq('id', reviewId).eq('venue_id', venueId).maybeSingle();
    if (error) throw error;
    return data as { id: string; user_id: string; venue_id: string; status: string; rating: number } | null;
};

export const setOwnerReply = async (reviewId: string, reply: string | null, userId: string) => {
    const { data, error } = await supabaseAdmin
        .from('reviews')
        .update(reply === null
            ? { owner_reply: null, owner_replied_at: null, owner_replied_by: null }
            : { owner_reply: reply, owner_replied_at: new Date().toISOString(), owner_replied_by: userId })
        .eq('id', reviewId)
        .select(REVIEW_COLUMNS)
        .single();
    if (error) throw error;
    return data;
};

export const setReviewStatus = async (reviewId: string, status: 'visible' | 'hidden', reason: string | null) => {
    const { data, error } = await supabaseAdmin
        .from('reviews')
        .update({ status, hidden_reason: status === 'hidden' ? reason : null })
        .eq('id', reviewId)
        .select(`${REVIEW_COLUMNS}, status, hidden_reason`)
        .maybeSingle();
    if (error) throw error;
    return data;
};

export const listReviewsForAdmin = async (status: 'visible' | 'hidden' | undefined, limit: number, offset: number) => {
    let query = supabaseAdmin
        .from('reviews')
        .select(`${REVIEW_COLUMNS}, status, hidden_reason, user_id, venue:venues(id, name, slug)`, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
    const { data, error, count } = await query;
    if (error) throw error;
    return { reviews: data, total: count ?? 0 };
};

// ---------- Favourites ----------

export const addFavourite = async (userId: string, venueId: string): Promise<void> => {
    const { error } = await supabaseAdmin.from('favourites').insert({ user_id: userId, venue_id: venueId });
    if (error && error.code !== '23505') throw error; // already a favourite: fine
};

export const removeFavourite = async (userId: string, venueId: string): Promise<boolean> => {
    const { data, error } = await supabaseAdmin.from('favourites').delete().eq('user_id', userId).eq('venue_id', venueId).select('venue_id');
    if (error) throw error;
    return data.length > 0;
};

export const isFavourite = async (userId: string, venueId: string): Promise<boolean> => {
    const { count, error } = await supabaseAdmin.from('favourites').select('venue_id', { count: 'exact', head: true }).eq('user_id', userId).eq('venue_id', venueId);
    if (error) throw error;
    return (count ?? 0) > 0;
};

// Favourites with a flag for venues that are currently not bookable (unlisted, suspended, deleted)
export const listFavourites = async (userId: string) => {
    const { data, error } = await supabaseAdmin
        .from('favourites')
        .select('created_at, venue:venues(id, name, slug, city, locality, status, deleted_at, rating_avg, rating_count, venue_photos(storage_path, is_cover))')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
    if (error) throw error;
    type Row = { created_at: string; venue: { id: string; name: string; slug: string; city: string | null; locality: string | null; status: string; deleted_at: string | null; rating_avg: number | null; rating_count: number; venue_photos: { storage_path: string; is_cover: boolean }[] } };
    return (data as unknown as Row[]).map(({ created_at, venue: { venue_photos, status, deleted_at, ...v } }) => {
        const cover = venue_photos.find((p) => p.is_cover);
        return { ...v, cover_url: cover ? thumbUrl(cover.storage_path) : null, available: status === 'live' && !deleted_at, saved_at: created_at };
    });
};

// ---------- Dashboards ----------

export const venueDashboard = async (venueId: string, from: string, to: string) => {
    const { data, error } = await supabaseAdmin.rpc('venue_dashboard', { p_venue_id: venueId, p_from: from, p_to: to });
    if (error) throw error;
    return data;
};

export const adminDashboard = async (from: string, to: string) => {
    const { data, error } = await supabaseAdmin.rpc('admin_dashboard', { p_from: from, p_to: to });
    if (error) throw error;
    return data;
};
