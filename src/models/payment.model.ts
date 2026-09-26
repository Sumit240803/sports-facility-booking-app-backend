import { supabaseAdmin } from '../lib/supabase.js';

// ---------- Payments ----------

export interface PaymentRow {
    id: string;
    booking_id: string;
    razorpay_order_id: string;
    razorpay_payment_id: string | null;
    amount_paise: number;
    status: 'created' | 'authorized' | 'captured' | 'failed';
    created_at: string;
}

// An order already created for this booking and amount that can still be paid
export const findOpenOrder = async (bookingId: string, amount: number): Promise<PaymentRow | null> => {
    const { data, error } = await supabaseAdmin
        .from('payments')
        .select('id, booking_id, razorpay_order_id, razorpay_payment_id, amount_paise, status, created_at')
        .eq('booking_id', bookingId)
        .eq('amount_paise', amount)
        .in('status', ['created', 'failed'])
        .is('razorpay_payment_id', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data as PaymentRow | null;
};

// Is this Razorpay order one of this user's orders for this booking?
export const isUserBookingOrder = async (orderId: string, bookingId: string, userId: string): Promise<boolean> => {
    const { count, error } = await supabaseAdmin
        .from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('razorpay_order_id', orderId)
        .eq('booking_id', bookingId)
        .eq('user_id', userId);
    if (error) throw error;
    return (count ?? 0) > 0;
};

export const insertPaymentOrder = async (bookingId: string, userId: string, orderId: string, amount: number): Promise<void> => {
    const { error } = await supabaseAdmin.from('payments').insert({ booking_id: bookingId, user_id: userId, razorpay_order_id: orderId, amount_paise: amount });
    if (error) throw error;
};

export type CaptureOutcome = { outcome: 'confirmed' | 'already_processed' | 'refund_queued' | 'unknown_order'; reason?: string; booking_id?: string };

export const recordCaptured = async (orderId: string, paymentId: string, amount: number, currency: string, method: string | null): Promise<CaptureOutcome> => {
    const { data, error } = await supabaseAdmin.rpc('record_payment_captured', {
        p_order_id: orderId,
        p_payment_id: paymentId,
        p_amount: amount,
        p_currency: currency,
        p_method: method,
    });
    if (error) throw error;
    return data as CaptureOutcome;
};

export const recordFailed = async (orderId: string, paymentId: string, code: string | null, description: string | null): Promise<void> => {
    const { error } = await supabaseAdmin.rpc('record_payment_failed', { p_order_id: orderId, p_payment_id: paymentId, p_code: code, p_description: description });
    if (error) throw error;
};

// Orders with no final result yet, not checked in the last 5 minutes (webhook may have been lost)
export const listStalePayments = async (limit: number) => {
    const now = Date.now();
    const { data, error } = await supabaseAdmin
        .from('payments')
        .select('id, razorpay_order_id, razorpay_payment_id, status')
        .in('status', ['created', 'authorized'])
        .lt('created_at', new Date(now - 3 * 60_000).toISOString())
        .gt('created_at', new Date(now - 2 * 86_400_000).toISOString())
        .or(`last_checked_at.is.null,last_checked_at.lt.${new Date(now - 5 * 60_000).toISOString()}`)
        .order('created_at')
        .limit(limit);
    if (error) throw error;
    return data as Pick<PaymentRow, 'id' | 'razorpay_order_id' | 'razorpay_payment_id' | 'status'>[];
};

export const markChecked = async (id: string): Promise<void> => {
    const { error } = await supabaseAdmin.from('payments').update({ last_checked_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
};

// First time we see a webhook event id? (Razorpay retries deliveries)
export const claimWebhookEvent = async (id: string, event: string): Promise<boolean> => {
    const { error } = await supabaseAdmin.from('webhook_events').insert({ id, event });
    if (!error) return true;
    if (error.code === '23505') return false;
    throw error;
};

export const releaseWebhookEvent = async (id: string): Promise<void> => {
    await supabaseAdmin.from('webhook_events').delete().eq('id', id);
};

// ---------- Refunds ----------

export interface ClaimedRefund {
    id: string;
    booking_id: string;
    amount_paise: number;
    attempts: number;
    razorpay_payment_id: string;
    razorpay_refund_id: string | null;
}

export const claimRefunds = async (limit: number, leaseSeconds: number): Promise<ClaimedRefund[]> => {
    const { data, error } = await supabaseAdmin.rpc('claim_refunds', { p_limit: limit, p_lease_seconds: leaseSeconds });
    if (error) throw error;
    return (data ?? []) as ClaimedRefund[];
};

export type RefundState = 'processing' | 'processed' | 'failed' | 'retry';

export const updateRefund = async (id: string, state: RefundState, razorpayRefundId?: string, reason?: string): Promise<void> => {
    const { error } = await supabaseAdmin.rpc('update_refund', {
        p_id: id,
        p_state: state,
        p_razorpay_refund_id: razorpayRefundId ?? null,
        p_error: reason ?? null,
    });
    if (error) throw error;
};

export const updateRefundByGatewayId = async (razorpayRefundId: string, state: 'processed' | 'failed', reason?: string): Promise<boolean> => {
    const { data, error } = await supabaseAdmin.rpc('update_refund_by_gateway_id', {
        p_razorpay_refund_id: razorpayRefundId,
        p_state: state,
        p_error: reason ?? null,
    });
    if (error) throw error;
    return Boolean(data);
};

export const listRefunds = async (status: string | undefined, limit: number, offset: number) => {
    let query = supabaseAdmin
        .from('refunds')
        .select('id, booking_id, amount_paise, reason, status, razorpay_refund_id, attempts, last_error, created_at, processed_at, booking:bookings(reference, venue_id, user_id)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
    const { data, error, count } = await query;
    if (error) throw error;
    return { refunds: data, total: count ?? 0 };
};

// Admin: put a failed refund back in the queue
export const retryRefund = async (id: string): Promise<boolean> => {
    const { data, error } = await supabaseAdmin
        .from('refunds')
        .update({ status: 'pending', attempts: 0, next_attempt_at: new Date().toISOString(), last_error: null })
        .eq('id', id)
        .eq('status', 'failed')
        .select('id');
    if (error) throw error;
    return data.length > 0;
};

// ---------- Payouts & ledger ----------

export interface PayoutSettings {
    venue_id: string;
    mode: 'manual' | 'route';
    razorpay_account_id: string | null;
    account_holder_name: string | null;
    bank_account_number: string | null;
    bank_ifsc: string | null;
    upi_id: string | null;
    updated_at: string;
}

export const getPayoutSettings = async (venueId: string): Promise<PayoutSettings | null> => {
    const { data, error } = await supabaseAdmin.from('venue_payout_settings').select('*').eq('venue_id', venueId).maybeSingle();
    if (error) throw error;
    return data as PayoutSettings | null;
};

// Update when a row exists, insert otherwise. (An upsert would check constraints such as
// "route needs a linked account" against the proposed new row, not the merged one.)
export const upsertPayoutSettings = async (venueId: string, changes: Partial<Omit<PayoutSettings, 'venue_id' | 'updated_at'>>, userId: string): Promise<PayoutSettings> => {
    const row = { ...changes, updated_by: userId, updated_at: new Date().toISOString() };
    const updated = await supabaseAdmin.from('venue_payout_settings').update(row).eq('venue_id', venueId).select('*');
    if (updated.error) throw updated.error;
    if (updated.data.length) return updated.data[0] as PayoutSettings;

    const inserted = await supabaseAdmin.from('venue_payout_settings').insert({ venue_id: venueId, ...row }).select('*').single();
    if (inserted.error?.code === '23505') return upsertPayoutSettings(venueId, changes, userId); // created concurrently: update it
    if (inserted.error) throw inserted.error;
    return inserted.data as PayoutSettings;
};

export const venueBalance = async (venueId: string): Promise<number> => {
    const { data, error } = await supabaseAdmin.rpc('venue_balance', { p_venue_id: venueId });
    if (error) throw error;
    return Number(data ?? 0);
};

export const listLedger = async (venueId: string, limit: number, offset: number) => {
    const { data, error, count } = await supabaseAdmin
        .from('venue_ledger')
        .select('id, entry_type, amount_paise, description, booking_id, payout_id, created_at, updated_at', { count: 'exact' })
        .eq('venue_id', venueId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (error) throw error;
    return { entries: data, total: count ?? 0 };
};

export const listPayouts = async (filters: { venueId?: string; status?: string }, limit: number, offset: number) => {
    let query = supabaseAdmin
        .from('payouts')
        .select('id, venue_id, amount_paise, mode, status, razorpay_transfer_id, reference, note, failed_reason, created_at, paid_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (filters.venueId) query = query.eq('venue_id', filters.venueId);
    if (filters.status) query = query.eq('status', filters.status);
    const { data, error, count } = await query;
    if (error) throw error;
    return { payouts: data, total: count ?? 0 };
};

const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await supabaseAdmin.rpc(fn, args);
    if (error) throw error;
    return data as T;
};

export const recordManualPayout = (venueId: string, amount: number, reference: string, note: string | null, adminId: string) =>
    rpc<Record<string, unknown>>('record_manual_payout', { p_venue_id: venueId, p_amount: amount, p_reference: reference, p_note: note, p_admin_id: adminId });

export const startRoutePayout = async (venueId: string, minAmount: number) => {
    const po = await rpc<{ id: string | null; amount_paise: number } | null>('start_route_payout', { p_venue_id: venueId, p_min_amount: minAmount });
    return po?.id ? (po as { id: string; amount_paise: number }) : null;
};

export const completePayout = (payoutId: string, status: 'paid' | 'failed', transferId?: string | null, reason?: string | null, actorId?: string | null) =>
    rpc<Record<string, unknown>>('complete_payout', {
        p_payout_id: payoutId,
        p_status: status,
        p_transfer_id: transferId ?? null,
        p_reason: reason ?? null,
        p_actor_id: actorId ?? null,
    });

export const findProcessingPayoutByTransfer = async (transferId: string): Promise<string | null> => {
    const { data, error } = await supabaseAdmin.from('payouts').select('id').eq('razorpay_transfer_id', transferId).eq('status', 'processing').maybeSingle();
    if (error) throw error;
    return data?.id ?? null;
};

export const setPayoutTransferId = async (payoutId: string, transferId: string): Promise<void> => {
    const { error } = await supabaseAdmin.from('payouts').update({ razorpay_transfer_id: transferId }).eq('id', payoutId);
    if (error) throw error;
};

export const addAdjustment = async (venueId: string, amount: number, note: string, adminId: string) => {
    const { data, error } = await supabaseAdmin
        .from('venue_ledger')
        .insert({ venue_id: venueId, entry_type: 'adjustment', amount_paise: amount, description: note, created_by: adminId })
        .select('id, entry_type, amount_paise, description, created_at')
        .single();
    if (error) throw error;
    return data;
};

// Route venues due for an automatic payout (no automatic payout in the last N hours, none in flight)
export const venuesDueForRoutePayout = async (everyHours: number): Promise<{ venue_id: string; razorpay_account_id: string }[]> => {
    const { data, error } = await supabaseAdmin
        .from('venue_payout_settings')
        .select('venue_id, razorpay_account_id')
        .eq('mode', 'route')
        .not('razorpay_account_id', 'is', null);
    if (error) throw error;
    if (!data.length) return [];
    const since = new Date(Date.now() - everyHours * 3_600_000).toISOString();
    const { data: recent, error: e2 } = await supabaseAdmin
        .from('payouts')
        .select('venue_id')
        .in('venue_id', data.map((d) => d.venue_id))
        .eq('mode', 'route') // manual settlements don't delay the automatic schedule
        .or(`status.eq.processing,created_at.gt.${since}`);
    if (e2) throw e2;
    const busy = new Set(recent.map((r) => r.venue_id));
    return (data as { venue_id: string; razorpay_account_id: string }[]).filter((d) => !busy.has(d.venue_id));
};

// All venues with a non-zero balance (admin overview)
export const listBalances = async () => {
    const { data, error } = await supabaseAdmin.rpc('list_venue_balances');
    if (error) throw error;
    return (data ?? []) as { venue_id: string; venue_name: string; venue_slug: string; city: string | null; payout_mode: string; balance_paise: number }[];
};
