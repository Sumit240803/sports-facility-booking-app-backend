import { supabaseAdmin } from '../lib/supabase.js';

const MAX_PUSH_TOKENS_PER_USER = 20;

// ---------- Notifications ----------

// In-app notification + email/push deliveries according to the user's preferences
export const notifyUser = async (userId: string, type: string, title: string, body: string, data: Record<string, unknown>): Promise<void> => {
    const { error } = await supabaseAdmin.rpc('notify_user', { p_user_id: userId, p_type: type, p_title: title, p_body: body, p_data: data });
    if (error) throw error;
};

export const listNotifications = async (userId: string, unreadOnly: boolean, limit: number, offset: number) => {
    let query = supabaseAdmin
        .from('notifications')
        .select('id, type, title, body, data, read_at, created_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (unreadOnly) query = query.is('read_at', null);
    const [list, unread] = await Promise.all([
        query,
        supabaseAdmin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('read_at', null),
    ]);
    if (list.error) throw list.error;
    if (unread.error) throw unread.error;
    return { notifications: list.data, total: list.count ?? 0, unread_count: unread.count ?? 0 };
};

// Returns false if the notification doesn't exist for this user
export const markRead = async (userId: string, id: string): Promise<boolean> => {
    const { data, error } = await supabaseAdmin
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', userId)
        .is('read_at', null)
        .select('id');
    if (error) throw error;
    if (data.length > 0) return true;
    // Already read counts as success; only a missing row is "not found"
    const { count, error: e2 } = await supabaseAdmin.from('notifications').select('id', { count: 'exact', head: true }).eq('id', id).eq('user_id', userId);
    if (e2) throw e2;
    return (count ?? 0) > 0;
};

export const markAllRead = async (userId: string): Promise<number> => {
    const { data, error } = await supabaseAdmin
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('user_id', userId)
        .is('read_at', null)
        .select('id');
    if (error) throw error;
    return data.length;
};

// ---------- Push tokens ----------

// A token identifies a device; if another account used it before, it now belongs to this user
export const registerPushToken = async (userId: string, token: string, platform: string): Promise<void> => {
    const { error } = await supabaseAdmin
        .from('push_tokens')
        .upsert({ user_id: userId, token, platform, last_seen_at: new Date().toISOString() }, { onConflict: 'token' });
    if (error) throw error;

    // Keep only the most recently seen tokens per user
    const { data, error: e2 } = await supabaseAdmin
        .from('push_tokens')
        .select('id')
        .eq('user_id', userId)
        .order('last_seen_at', { ascending: false })
        .range(MAX_PUSH_TOKENS_PER_USER, MAX_PUSH_TOKENS_PER_USER + 100);
    if (e2) throw e2;
    if (data.length) {
        const { error: e3 } = await supabaseAdmin.from('push_tokens').delete().in('id', data.map((r) => r.id));
        if (e3) throw e3;
    }
};

export const removePushToken = async (userId: string, token: string): Promise<void> => {
    const { error } = await supabaseAdmin.from('push_tokens').delete().eq('user_id', userId).eq('token', token);
    if (error) throw error;
};

export const getPushTokens = async (userId: string): Promise<string[]> => {
    const { data, error } = await supabaseAdmin.from('push_tokens').select('token').eq('user_id', userId);
    if (error) throw error;
    return data.map((r) => r.token as string);
};

export const deletePushTokens = async (tokens: string[]): Promise<void> => {
    if (!tokens.length) return;
    const { error } = await supabaseAdmin.from('push_tokens').delete().in('token', tokens);
    if (error) throw error;
};

// ---------- Delivery outbox (used by the background job) ----------

export interface ClaimedDelivery {
    id: string;
    channel: 'email' | 'push';
    attempts: number;
    user_id: string;
    email: string | null;
    title: string;
    body: string;
    data: Record<string, unknown>;
}

export const claimDeliveries = async (limit: number, leaseSeconds: number): Promise<ClaimedDelivery[]> => {
    const { data, error } = await supabaseAdmin.rpc('claim_deliveries', { p_limit: limit, p_lease_seconds: leaseSeconds });
    if (error) throw error;
    return (data ?? []) as ClaimedDelivery[];
};

export type DeliveryOutcome = 'sent' | 'skipped' | 'failed' | 'retry';

export const completeDelivery = async (id: string, outcome: DeliveryOutcome, reason?: string): Promise<void> => {
    const { error } = await supabaseAdmin.rpc('complete_delivery', { p_id: id, p_outcome: outcome, p_error: reason ?? null });
    if (error) throw error;
};

export const processDueReminders = async (limit: number): Promise<number> => {
    const { data, error } = await supabaseAdmin.rpc('process_due_reminders', { p_limit: limit });
    if (error) throw error;
    return Number(data ?? 0);
};

// ---------- Reminders ----------

export const createReminder = async (userId: string, courtId: string, date: string, slotStart: string) => {
    const { data, error } = await supabaseAdmin.rpc('create_slot_reminder', {
        p_user_id: userId,
        p_court_id: courtId,
        p_date: date,
        p_slot_start: slotStart,
    });
    if (error) throw error;
    return data;
};

export const listReminders = async (userId: string, status?: string) => {
    let query = supabaseAdmin
        .from('slot_reminders')
        .select('id, slot_start, slot_date, notify_at, status, sent_at, created_at, court:courts(id, name, sport_id), venue:venues(id, name, slug, city)')
        .eq('user_id', userId)
        .order('slot_start')
        .limit(200);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    return data;
};

// Only pending reminders can be cancelled; returns false if not found / not pending
export const cancelReminder = async (userId: string, id: string): Promise<boolean> => {
    const { data, error } = await supabaseAdmin
        .from('slot_reminders')
        .update({ status: 'cancelled' })
        .eq('id', id)
        .eq('user_id', userId)
        .eq('status', 'pending')
        .select('id');
    if (error) throw error;
    return data.length > 0;
};
