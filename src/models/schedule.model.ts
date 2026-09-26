import { supabaseAdmin } from '../lib/supabase.js';
import { minutesToTime } from '../utils/validate.js';

export interface HoursRange { day: number; start: number; end: number }
export interface PriceRuleInput { days: number[] | null; date: string | null; start: number; end: number; price: number }

interface HoursRow { day_of_week: number; start_minute: number; end_minute: number; court_id: string | null }
interface PriceRuleRow {
    id: string;
    days: number[] | null;
    on_date: string | null;
    start_minute: number;
    end_minute: number;
    price_per_hour_paise: number;
}

// API shape: { day, open: "HH:MM", close: "HH:MM", closes_next_day }
export const hoursToApi = (rows: HoursRow[]) =>
    rows
        .sort((a, b) => a.day_of_week - b.day_of_week || a.start_minute - b.start_minute)
        .map((r) => ({
            day: r.day_of_week,
            open: minutesToTime(r.start_minute),
            close: minutesToTime(r.end_minute),
            // close is on the following calendar day (includes closing exactly at midnight)
            closes_next_day: r.end_minute >= 1440,
        }));

const ruleToApi = (r: PriceRuleRow) => ({
    id: r.id,
    days: r.days,
    date: r.on_date,
    start: minutesToTime(r.start_minute),
    end: r.end_minute === 1440 ? '24:00' : minutesToTime(r.end_minute),
    price_per_hour_paise: r.price_per_hour_paise,
});

export const getVenueHours = async (venueId: string) => {
    const { data, error } = await supabaseAdmin
        .from('opening_hours')
        .select('day_of_week, start_minute, end_minute, court_id')
        .eq('venue_id', venueId);
    if (error) throw error;
    const rows = data as HoursRow[];
    const courtHours: Record<string, ReturnType<typeof hoursToApi>> = {};
    for (const courtId of new Set(rows.filter((r) => r.court_id).map((r) => r.court_id!))) {
        courtHours[courtId] = hoursToApi(rows.filter((r) => r.court_id === courtId));
    }
    return { venue: hoursToApi(rows.filter((r) => !r.court_id)), courts: courtHours };
};

export const setHours = async (venueId: string, courtId: string | null, ranges: HoursRange[]): Promise<void> => {
    const { error } = await supabaseAdmin.rpc('set_opening_hours', { p_venue_id: venueId, p_court_id: courtId, p_ranges: ranges });
    if (error) throw error;
};

export const resetCourtHours = async (venueId: string, courtId: string): Promise<void> => {
    const { error } = await supabaseAdmin.rpc('reset_court_hours', { p_venue_id: venueId, p_court_id: courtId });
    if (error) throw error;
};

export const getPriceRules = async (courtId: string) => {
    const { data, error } = await supabaseAdmin
        .from('price_rules')
        .select('id, days, on_date, start_minute, end_minute, price_per_hour_paise')
        .eq('court_id', courtId)
        .order('on_date', { nullsFirst: true })
        .order('start_minute');
    if (error) throw error;
    return (data as PriceRuleRow[]).map(ruleToApi);
};

export const setPriceRules = async (venueId: string, courtId: string, rules: PriceRuleInput[]): Promise<void> => {
    const { error } = await supabaseAdmin.rpc('set_price_rules', { p_venue_id: venueId, p_court_id: courtId, p_rules: rules });
    if (error) throw error;
};

// ---------- Blocks ----------

export interface BlockInput { court_id: string | null; starts_at: string; ends_at: string; reason: string | null }

export const listBlocks = async (venueId: string, from: string, to: string) => {
    const { data, error } = await supabaseAdmin
        .from('court_blocks')
        .select('id, court_id, starts_at, ends_at, reason, created_by, created_at')
        .eq('venue_id', venueId)
        .gt('ends_at', from)
        .lt('starts_at', to)
        .order('starts_at')
        .limit(500);
    if (error) throw error;
    return data;
};

export const createBlock = async (venueId: string, input: BlockInput, userId: string) => {
    const { data, error } = await supabaseAdmin
        .from('court_blocks')
        .insert({ ...input, venue_id: venueId, created_by: userId })
        .select('id, court_id, starts_at, ends_at, reason, created_by, created_at')
        .single();
    if (error) throw error;
    return data;
};

export const deleteBlock = async (venueId: string, blockId: string): Promise<boolean> => {
    const { data, error } = await supabaseAdmin.from('court_blocks').delete().eq('id', blockId).eq('venue_id', venueId).select('id');
    if (error) throw error;
    return data.length > 0;
};

// ---------- Availability ----------

export interface VenueSchedule {
    id: string;
    timezone: string;
    booking_window_days: number;
    listing_window_days: number;
    min_notice_minutes: number;
}

const SCHEDULE_COLUMNS = 'id, timezone, booking_window_days, listing_window_days, min_notice_minutes';

export const findVenueSchedule = async (venueId: string): Promise<VenueSchedule | null> => {
    const { data, error } = await supabaseAdmin.from('venues').select(SCHEDULE_COLUMNS).eq('id', venueId).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    return data as VenueSchedule | null;
};

// Live venue of an active owner, by id or slug
export const findPublicVenueSchedule = async (key: { id: string } | { slug: string }): Promise<VenueSchedule | null> => {
    let query = supabaseAdmin
        .from('venues')
        .select(`${SCHEDULE_COLUMNS}, owner:profiles!venues_owner_id_fkey!inner(status, role)`)
        .eq('status', 'live')
        .is('deleted_at', null)
        .eq('owner.status', 'active')
        .in('owner.role', ['venue_owner', 'admin']);
    query = 'id' in key ? query.eq('id', key.id) : query.eq('slug', key.slug);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const { owner: _owner, ...schedule } = data as VenueSchedule & { owner: unknown };
    return schedule;
};

interface SlotRow { court_id: string; slot_start: string; slot_end: string; price_paise: number; status: string; opens_at: string }

export const getAvailability = async (venueId: string, date: string, courtId?: string) => {
    const [slots, courts] = await Promise.all([
        supabaseAdmin.rpc('get_availability', { p_venue_id: venueId, p_date: date, p_court_id: courtId ?? null }),
        supabaseAdmin
            .from('courts')
            .select('id, name, sport_id, is_indoor, base_slot_minutes, min_duration_minutes, max_duration_minutes, sort_order')
            .eq('venue_id', venueId)
            .eq('is_active', true)
            .is('deleted_at', null)
            .not('price_per_hour_paise', 'is', null)
            .order('sort_order')
            .order('created_at'),
    ]);
    if (slots.error) throw slots.error;
    if (courts.error) throw courts.error;

    const byCourt = new Map<string, SlotRow[]>();
    for (const s of slots.data as SlotRow[]) {
        const list = byCourt.get(s.court_id) ?? [];
        list.push(s);
        byCourt.set(s.court_id, list);
    }
    return (courts.data as Array<{ id: string; sort_order: number }>)
        .filter((c) => !courtId || c.id === courtId)
        .map(({ sort_order: _s, ...c }) => ({
            ...c,
            slots: (byCourt.get(c.id) ?? []).map((s) => ({
                start: s.slot_start,
                end: s.slot_end,
                price_paise: s.price_paise,
                status: s.status,
                ...(s.status === 'not_yet_open' ? { opens_at: s.opens_at } : {}),
            })),
        }));
};
