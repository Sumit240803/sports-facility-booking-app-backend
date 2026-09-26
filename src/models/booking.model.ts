import { env } from '../config/env.js';
import { supabaseAdmin } from '../lib/supabase.js';

export const BOOKING_STATUSES = ['pending_payment', 'confirmed', 'checked_in', 'completed', 'cancelled', 'expired', 'no_show'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export type PaymentMethod = 'online' | 'pay_at_venue' | 'offline';

export interface PolicyTier { hours_before: number; refund_percent: number }

export interface Booking {
    id: string;
    reference: string;
    venue_id: string;
    court_id: string;
    user_id: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    starts_at: string;
    ends_at: string;
    slot_date: string;
    duration_minutes: number;
    status: BookingStatus;
    payment_method: PaymentMethod;
    payment_status: 'pending' | 'paid' | 'due' | 'collected';
    subtotal_paise: number;
    discount_percent: number;
    discount_paise: number;
    total_paise: number;
    slots: { start: string; end: string; price_paise: number }[];
    cancellation_policy: PolicyTier[];
    expires_at: string | null;
    notes: string | null;
    checked_in_at: string | null;
    collected_paise: number | null;
    cancelled_at: string | null;
    cancelled_by_role: string | null;
    cancel_reason: string | null;
    refund_percent: number | null;
    refund_paise: number | null;
    refund_status: 'none' | 'pending' | 'processed' | 'failed';
    created_at: string;
    updated_at: string;
}

const COLUMNS = 'id, reference, venue_id, court_id, user_id, customer_name, customer_phone, starts_at, ends_at, slot_date, duration_minutes, status, payment_method, payment_status, subtotal_paise, discount_percent, discount_paise, total_paise, slots, cancellation_policy, expires_at, notes, checked_in_at, collected_paise, cancelled_at, cancelled_by_role, cancel_reason, refund_percent, refund_paise, refund_status, created_at, updated_at';
const WITH_PLACE = `${COLUMNS}, court:courts(id, name, sport_id), venue:venues(id, name, slug, address_line, locality, city, phone, timezone)`;
const WITH_CUSTOMER = `${COLUMNS}, court:courts(id, name, sport_id), customer:profiles!bookings_user_id_fkey(id, full_name, phone, email)`;

// Same rule as policy_refund_percent() in SQL: the first tier whose notice is met wins
export const refundPercentNow = (policy: PolicyTier[], startsAt: string): number => {
    const hoursLeft = (Date.parse(startsAt) - Date.now()) / 3_600_000;
    const tier = [...policy].sort((a, b) => b.hours_before - a.hours_before).find((t) => hoursLeft >= t.hours_before);
    return tier?.refund_percent ?? 0;
};

// What the player would get back if they cancelled right now
export const cancellationPreview = (b: Booking) => {
    const allowed = (b.status === 'confirmed' || (b.status === 'pending_payment' && Date.parse(b.expires_at ?? '') > Date.now()))
        && Date.parse(b.starts_at) > Date.now();
    const pct = b.payment_status === 'paid' ? refundPercentNow(b.cancellation_policy, b.starts_at) : 0;
    return { allowed, refund_percent: allowed ? pct : 0, refund_paise: allowed ? Math.round((b.total_paise * pct) / 100) : 0 };
};

export interface BookingRequest {
    courtId: string;
    date: string;
    start: string;
    durationMinutes: number;
    method: PaymentMethod;
}

export const quoteBooking = async (userId: string | null, r: BookingRequest) => {
    const { data, error } = await supabaseAdmin.rpc('prepare_booking', {
        p_user_id: userId,
        p_court_id: r.courtId,
        p_date: r.date,
        p_start: r.start,
        p_duration: r.durationMinutes,
        p_method: r.method,
        p_discount_percent: env.booking.onlineDiscountPercent,
    });
    if (error) throw error;
    const { venue_id: _v, timezone: _tz, ...quote } = data as Record<string, unknown>;
    return quote;
};

export const createBooking = async (
    userId: string | null,
    actorId: string,
    r: BookingRequest,
    extra: { customerName?: string | null; customerPhone?: string | null; notes?: string | null; idempotencyKey?: string | null },
): Promise<Booking> => {
    const { data, error } = await supabaseAdmin.rpc('create_booking', {
        p_user_id: userId,
        p_actor_id: actorId,
        p_court_id: r.courtId,
        p_date: r.date,
        p_start: r.start,
        p_duration: r.durationMinutes,
        p_method: r.method,
        p_discount_percent: env.booking.onlineDiscountPercent,
        p_hold_minutes: env.booking.holdMinutes,
        p_customer_name: extra.customerName ?? null,
        p_customer_phone: extra.customerPhone ?? null,
        p_notes: extra.notes ?? null,
        p_idempotency_key: extra.idempotencyKey ?? null,
    });
    if (error) throw error;
    return strip(data as Booking & Record<string, unknown>);
};

// Drop internal columns returned by RPCs that return the full row
const strip = (row: Booking & Record<string, unknown>): Booking => {
    const { during: _d, idempotency_key: _k, game_reminder_sent_at: _g, created_by: _c, checked_in_by: _ci, cancelled_by: _cb, ...b } = row;
    return b as Booking;
};

const rpcBooking = async (fn: string, args: Record<string, unknown>): Promise<Booking> => {
    const { data, error } = await supabaseAdmin.rpc(fn, args);
    if (error) throw error;
    return strip(data as Booking & Record<string, unknown>);
};

export const cancelBooking = (bookingId: string, actorId: string, role: 'player' | 'venue' | 'admin', reason?: string | null) =>
    rpcBooking('cancel_booking', { p_booking_id: bookingId, p_actor_id: actorId, p_role: role, p_reason: reason ?? null });

export const checkInBooking = (bookingId: string, venueId: string, actorId: string, collectedPaise?: number) =>
    rpcBooking('check_in_booking', { p_booking_id: bookingId, p_venue_id: venueId, p_actor_id: actorId, p_collected_paise: collectedPaise ?? null });

export const collectPayment = (bookingId: string, venueId: string, actorId: string, amountPaise: number) =>
    rpcBooking('collect_booking_payment', { p_booking_id: bookingId, p_venue_id: venueId, p_actor_id: actorId, p_amount_paise: amountPaise });

export const markNoShow = (bookingId: string, venueId: string, actorId: string) =>
    rpcBooking('mark_no_show', { p_booking_id: bookingId, p_venue_id: venueId, p_actor_id: actorId });

export const undoNoShow = (bookingId: string, venueId: string, actorId: string) =>
    rpcBooking('undo_no_show', { p_booking_id: bookingId, p_venue_id: venueId, p_actor_id: actorId });

// ---------- Player queries ----------

export const listUserBookings = async (userId: string, scope: 'upcoming' | 'past', limit: number, offset: number) => {
    const now = new Date().toISOString();
    let query = supabaseAdmin.from('bookings').select(WITH_PLACE, { count: 'exact' }).eq('user_id', userId).range(offset, offset + limit - 1);
    query = scope === 'upcoming'
        ? query.gt('ends_at', now).in('status', ['pending_payment', 'confirmed', 'checked_in']).order('starts_at', { ascending: true })
        : query.or(`ends_at.lte.${now},status.in.(cancelled,expired,completed,no_show)`).order('starts_at', { ascending: false });
    const { data, error, count } = await query;
    if (error) throw error;
    const bookings = (data as unknown as Booking[])
        // an unpaid hold that ran out but wasn't swept yet is not "upcoming"
        .filter((b) => scope === 'past' || b.status !== 'pending_payment' || Date.parse(b.expires_at ?? '') > Date.now())
        .map((b) => ({ ...b, cancellation: cancellationPreview(b) }));
    return { bookings, total: count ?? 0 };
};

export const getUserBooking = async (userId: string, id: string) => {
    const { data, error } = await supabaseAdmin.from('bookings').select(WITH_PLACE).eq('id', id).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const b = data as unknown as Booking;
    return { ...b, cancellation: cancellationPreview(b) };
};

// ---------- Venue queries ----------

export const listVenueBookings = async (venueId: string, from: string, to: string, statuses?: BookingStatus[]) => {
    let query = supabaseAdmin
        .from('bookings')
        .select(WITH_CUSTOMER)
        .eq('venue_id', venueId)
        .lt('starts_at', to)
        .gt('ends_at', from)
        .order('starts_at')
        .limit(1000);
    if (statuses?.length) query = query.in('status', statuses);
    const { data, error } = await query;
    if (error) throw error;
    return data;
};

export const getVenueBooking = async (venueId: string, key: { id: string } | { reference: string }) => {
    let query = supabaseAdmin.from('bookings').select(`${WITH_CUSTOMER}, events:booking_events(from_status, to_status, actor_id, note, created_at)`).eq('venue_id', venueId);
    query = 'id' in key ? query.eq('id', key.id) : query.eq('reference', key.reference);
    const { data, error } = await query.order('id', { referencedTable: 'booking_events' }).maybeSingle();
    if (error) throw error;
    return data;
};

// ---------- Job ----------

export const processBookingJobs = async (limit: number) => {
    const { data, error } = await supabaseAdmin.rpc('process_booking_jobs', { p_limit: limit });
    if (error) throw error;
    return data as { expired: number; completed: number; reminded: number };
};
