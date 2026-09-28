import { thumbKey } from '../lib/image.js';
import { publicUrl } from '../lib/r2.js';
import { getVenueHours } from './schedule.model.js';
import { supabaseAdmin } from '../lib/supabase.js';

export const VENUE_STATUSES = ['draft', 'pending_review', 'live', 'rejected', 'suspended'] as const;
export type VenueStatus = (typeof VENUE_STATUSES)[number];

export const OWNER_VENUE_ACTIONS = ['submit', 'unpublish'] as const;
export const ADMIN_VENUE_ACTIONS = ['approve', 'reject', 'suspend', 'reinstate'] as const;
export type VenueAction = (typeof OWNER_VENUE_ACTIONS)[number] | (typeof ADMIN_VENUE_ACTIONS)[number];

export interface VenueRow {
    id: string;
    owner_id: string;
    name: string;
    slug: string;
    description: string | null;
    phone: string | null;
    email: string | null;
    address_line: string | null;
    locality: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    lat: number | null;
    lng: number | null;
    amenities: string[];
    rules: string | null;
    timezone: string;
    booking_window_days: number;
    listing_window_days: number;
    min_notice_minutes: number;
    pay_at_venue_enabled: boolean;
    pay_at_venue_window_minutes: number;
    cancellation_policy: { hours_before: number; refund_percent: number }[];
    status: VenueStatus;
    status_reason: string | null;
    submitted_at: string | null;
    reviewed_by: string | null;
    reviewed_at: string | null;
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
}

export type VenueInput = Partial<Pick<VenueRow,
    'name' | 'description' | 'phone' | 'email' | 'address_line' | 'locality' | 'city' | 'state' |
    'pincode' | 'lat' | 'lng' | 'amenities' | 'rules' | 'timezone' |
    'booking_window_days' | 'listing_window_days' | 'min_notice_minutes' |
    'pay_at_venue_enabled' | 'pay_at_venue_window_minutes' | 'cancellation_policy'>>;

// Every column except the generated PostGIS `location`, which PostgREST returns as hex WKB
const VENUE_COLUMNS = 'id, owner_id, name, slug, description, phone, email, address_line, locality, city, state, pincode, lat, lng, amenities, rules, timezone, booking_window_days, listing_window_days, min_notice_minutes, pay_at_venue_enabled, pay_at_venue_window_minutes, cancellation_policy, status, status_reason, submitted_at, reviewed_by, reviewed_at, deleted_at, created_at, updated_at';
const PUBLIC_VENUE_COLUMNS = 'id, name, slug, description, phone, email, address_line, locality, city, state, pincode, lat, lng, amenities, rules, timezone, booking_window_days, listing_window_days, min_notice_minutes, pay_at_venue_enabled, pay_at_venue_window_minutes, cancellation_policy, rating_avg, rating_count, created_at';
const PUBLIC_COURT_COLUMNS = 'id, name, sport_id, is_indoor, surface, capacity, base_slot_minutes, min_duration_minutes, max_duration_minutes, price_per_hour_paise, uses_venue_hours, sort_order';

export const photoUrl = (key: string): string => publicUrl(key);
export const thumbUrl = (key: string): string => publicUrl(thumbKey(key));

const withPhotoUrls = (photos: { storage_path: string }[] | null) =>
    (photos ?? []).map(({ storage_path, ...rest }) => ({ ...rest, url: photoUrl(storage_path), thumb_url: thumbUrl(storage_path) }));

export const createVenue = async (ownerId: string, input: VenueInput & { name: string }): Promise<VenueRow> => {
    const { data, error } = await supabaseAdmin
        .from('venues')
        .insert({ ...input, owner_id: ownerId })
        .select(VENUE_COLUMNS)
        .single();
    if (error) throw error;
    return data as unknown as VenueRow;
};

export const findVenueRow = async (id: string): Promise<VenueRow | null> => {
    const { data, error } = await supabaseAdmin.from('venues').select(VENUE_COLUMNS).eq('id', id).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    return data as unknown as VenueRow | null;
};

export const updateVenue = async (id: string, changes: VenueInput): Promise<VenueRow> => {
    const { data, error } = await supabaseAdmin
        .from('venues')
        .update(changes)
        .eq('id', id)
        .is('deleted_at', null)
        .select(VENUE_COLUMNS)
        .single();
    if (error) throw error;
    return data as unknown as VenueRow;
};

export const softDeleteVenue = async (id: string): Promise<void> => {
    const { error } = await supabaseAdmin.from('venues').update({ deleted_at: new Date().toISOString() }).eq('id', id).is('deleted_at', null);
    if (error) throw error;
};

export const transitionVenue = async (id: string, action: VenueAction, actorId: string, reason?: string): Promise<VenueRow> => {
    const { data, error } = await supabaseAdmin.rpc('transition_venue', {
        p_venue_id: id,
        p_action: action,
        p_actor_id: actorId,
        p_reason: reason ?? null,
    });
    if (error) throw error;
    const { location: _location, ...venue } = data as VenueRow & { location?: unknown };
    return venue;
};

// Full venue for owner/staff/admin management screens (any status)
export const getManagedVenue = async (id: string) => {
    const venue = await findVenueRow(id);
    if (!venue) return null;
    const [courts, photos, hours] = await Promise.all([
        supabaseAdmin.from('courts').select('*').eq('venue_id', id).is('deleted_at', null).order('sort_order').order('created_at'),
        supabaseAdmin.from('venue_photos').select('id, storage_path, is_cover, sort_order, created_at').eq('venue_id', id).order('sort_order'),
        getVenueHours(id),
    ]);
    if (courts.error) throw courts.error;
    if (photos.error) throw photos.error;
    return { ...venue, courts: courts.data, photos: withPhotoUrls(photos.data), hours: hours.venue, court_hours: hours.courts };
};

// Public venue page: only live venues of active owners
export const getPublicVenue = async (key: { id: string } | { slug: string }) => {
    let query = supabaseAdmin
        .from('venues')
        .select(`${PUBLIC_VENUE_COLUMNS}, owner:profiles!venues_owner_id_fkey!inner(status, role)`)
        .eq('status', 'live')
        .is('deleted_at', null)
        .eq('owner.status', 'active')
        .in('owner.role', ['venue_owner', 'admin']);
    query = 'id' in key ? query.eq('id', key.id) : query.eq('slug', key.slug);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const { owner: _owner, ...venue } = data as Record<string, unknown> & { id: string };
    const [courts, photos, hours] = await Promise.all([
        supabaseAdmin.from('courts').select(PUBLIC_COURT_COLUMNS).eq('venue_id', venue.id).eq('is_active', true).is('deleted_at', null).order('sort_order').order('created_at'),
        supabaseAdmin.from('venue_photos').select('id, storage_path, is_cover, sort_order').eq('venue_id', venue.id).order('sort_order'),
        getVenueHours(venue.id),
    ]);
    if (courts.error) throw courts.error;
    if (photos.error) throw photos.error;

    const sports = [...new Set((courts.data as { sport_id: string }[]).map((c) => c.sport_id))].sort();
    return { ...venue, sports, courts: courts.data, photos: withPhotoUrls(photos.data), hours: hours.venue, court_hours: hours.courts };
};

export interface SearchParams {
    city?: string | undefined;
    sport?: string | undefined;
    q?: string | undefined;
    amenities?: string[] | undefined;
    lat?: number | undefined;
    lng?: number | undefined;
    radiusKm?: number | undefined;
    sort: 'name' | 'distance' | 'newest' | 'rating';
    minRating?: number | undefined;
    limit: number;
    offset: number;
}

export const searchVenues = async (p: SearchParams) => {
    const { data, error } = await supabaseAdmin.rpc('search_venues', {
        p_city: p.city ?? null,
        p_sport: p.sport ?? null,
        p_q: p.q ?? null,
        p_amenities: p.amenities?.length ? p.amenities : null,
        p_lat: p.lat ?? null,
        p_lng: p.lng ?? null,
        p_radius_km: p.radiusKm ?? null,
        p_sort: p.sort,
        p_limit: p.limit,
        p_offset: p.offset,
        p_min_rating: p.minRating ?? null,
    });
    if (error) throw error;
    const rows = (data ?? []) as Array<Record<string, unknown> & { cover_path: string | null; total_count: number; distance_km: number | null }>;
    return {
        total: rows[0] ? Number(rows[0].total_count) : 0,
        venues: rows.map(({ cover_path, total_count: _total, distance_km, ...v }) => ({
            ...v,
            distance_km: distance_km === null ? null : Math.round(distance_km * 10) / 10,
            rating_avg: v.rating_avg === null ? null : Number(v.rating_avg),
            cover_url: cover_path ? thumbUrl(cover_path) : null,
        })),
    };
};

export const listVenueCities = async () => {
    const { data, error } = await supabaseAdmin.rpc('list_venue_cities');
    if (error) throw error;
    return (data ?? []) as { city: string; venue_count: number }[];
};

const coverOf = (photos: { storage_path: string; is_cover: boolean }[] | null) => {
    const cover = (photos ?? []).find((ph) => ph.is_cover);
    return cover ? thumbUrl(cover.storage_path) : null;
};

const SUMMARY_COLUMNS = 'id, name, slug, city, locality, status, status_reason, created_at, updated_at, venue_photos(storage_path, is_cover)';

type SummaryRow = Record<string, unknown> & { venue_photos: { storage_path: string; is_cover: boolean }[] | null };
const toSummary = ({ venue_photos, ...v }: SummaryRow) => ({ ...v, cover_url: coverOf(venue_photos) });

// Venues the user owns plus venues where they are staff
export const listMyVenues = async (userId: string) => {
    const [owned, staff] = await Promise.all([
        supabaseAdmin.from('venues').select(SUMMARY_COLUMNS).eq('owner_id', userId).is('deleted_at', null).order('created_at', { ascending: false }),
        supabaseAdmin
            .from('venue_staff')
            .select(`role, venue:venues!inner(${SUMMARY_COLUMNS})`)
            .eq('user_id', userId)
            .is('venue.deleted_at', null),
    ]);
    if (owned.error) throw owned.error;
    if (staff.error) throw staff.error;
    return {
        owned: (owned.data as unknown as SummaryRow[]).map(toSummary),
        staff: (staff.data as unknown as { role: string; venue: SummaryRow }[]).map((s) => ({ role: s.role, venue: toSummary(s.venue) })),
    };
};

export const listVenuesForAdmin = async (filters: { status?: VenueStatus | undefined; city?: string | undefined }, limit: number, offset: number) => {
    let query = supabaseAdmin
        .from('venues')
        .select(`${SUMMARY_COLUMNS}, submitted_at, owner:profiles!venues_owner_id_fkey(id, email, full_name, phone)`, { count: 'exact' })
        .is('deleted_at', null)
        .order('submitted_at', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })
        .range(offset, offset + limit - 1);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.city) query = query.ilike('city', filters.city);
    const { data, error, count } = await query;
    if (error) throw error;
    return { total: count ?? 0, venues: (data as unknown as SummaryRow[]).map(toSummary) };
};
