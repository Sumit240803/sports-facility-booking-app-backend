import { env } from '../config/env.js';
import { EmailError, emailEnabled, sendEmail } from '../lib/email.js';
import { pushEnabled, sendPush } from '../lib/push.js';
import {
    claimDeliveries,
    completeDelivery,
    deletePushTokens,
    getPushTokens,
    processDueReminders,
    type ClaimedDelivery,
} from '../models/notification.model.js';

const INTERVAL_MS = 30_000;
const BATCH = 100;
const LEASE_SECONDS = 120; // a crashed worker's claims are picked up again after this

const bookingLink = (data: Record<string, unknown>) =>
    typeof data.venue_slug === 'string' ? `${env.frontendUrl}/venues/${data.venue_slug}?date=${data.date ?? ''}` : undefined;

const deliver = async (d: ClaimedDelivery): Promise<void> => {
    try {
        if (d.channel === 'email') {
            if (!emailEnabled() || !d.email) { await completeDelivery(d.id, 'skipped', emailEnabled() ? 'User has no email' : 'Email not configured'); return; }
            const link = bookingLink(d.data);
            await sendEmail({ to: d.email, subject: d.title, text: d.body, idempotencyKey: `delivery-${d.id}`, ...(link ? { link } : {}) });
            await completeDelivery(d.id, 'sent');
            return;
        }

        if (!pushEnabled()) { await completeDelivery(d.id, 'skipped', 'Push not configured'); return; }
        const tokens = await getPushTokens(d.user_id);
        if (!tokens.length) { await completeDelivery(d.id, 'skipped', 'No push tokens'); return; }

        const result = await sendPush(tokens, d.title, d.body, d.data);
        await deletePushTokens(result.deadTokens);
        if (result.sent > 0) await completeDelivery(d.id, 'sent');
        else if (result.retryable) await completeDelivery(d.id, 'retry', result.error);
        else await completeDelivery(d.id, 'skipped', 'All push tokens were invalid');
    } catch (e) {
        const retryable = e instanceof EmailError ? e.retryable : true;
        await completeDelivery(d.id, retryable ? 'retry' : 'failed', (e as Error).message).catch((err) =>
            console.error('Failed to record delivery outcome', d.id, err),
        );
    }
};

let running = false;

// One tick: turn due reminders into notifications, then send pending email/push deliveries
export const runNotificationsTick = async (): Promise<void> => {
    if (running) return; // never overlap ticks in this process
    running = true;
    try {
        while ((await processDueReminders(BATCH)) === BATCH) { /* keep draining */ }
        for (let batch = await claimDeliveries(BATCH, LEASE_SECONDS); batch.length; batch = await claimDeliveries(BATCH, LEASE_SECONDS)) {
            await Promise.all(batch.map(deliver));
            if (batch.length < BATCH) break;
        }
    } catch (e) {
        console.error('Notifications job failed', e);
    } finally {
        running = false;
    }
};

export const startNotificationsJob = (): (() => void) => {
    if (!env.jobsEnabled) return () => {};
    if (!emailEnabled()) console.warn('Email notifications disabled: set RESEND_API_KEY and EMAIL_FROM');
    if (!pushEnabled()) console.warn('Push notifications disabled: set FIREBASE_SERVICE_ACCOUNT');
    const timer = setInterval(() => void runNotificationsTick(), INTERVAL_MS);
    void runNotificationsTick();
    return () => clearInterval(timer);
};
