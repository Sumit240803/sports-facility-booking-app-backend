import { env } from '../config/env.js';
import { createRefund, createTransfer, fetchOrderPayments, listPaymentRefunds, RazorpayError, razorpayEnabled } from '../lib/razorpay.js';
import { applyGatewayPayment } from '../controllers/payment.controller.js';
import {
    claimRefunds,
    completePayout,
    listStalePayments,
    markChecked,
    setPayoutTransferId,
    startRoutePayout,
    updateRefund,
    venuesDueForRoutePayout,
    type ClaimedRefund,
} from '../models/payment.model.js';

const BATCH = 50;
const LEASE_SECONDS = 120;

const processRefund = async (r: ClaimedRefund): Promise<void> => {
    try {
        // A previous attempt may have reached Razorpay before timing out: adopt that refund instead of refunding twice
        if (r.attempts > 1 || r.razorpay_refund_id) {
            const existing = (await listPaymentRefunds(r.razorpay_payment_id)).find((x) => x.notes?.refund_id === r.id || x.id === r.razorpay_refund_id);
            if (existing) {
                await updateRefund(r.id, existing.status === 'processed' ? 'processed' : existing.status === 'failed' ? 'failed' : 'processing', existing.id);
                return;
            }
        }
        const refund = await createRefund(r.razorpay_payment_id, r.amount_paise, r.id);
        await updateRefund(r.id, refund.status === 'processed' ? 'processed' : 'processing', refund.id);
    } catch (e) {
        const retryable = !(e instanceof RazorpayError) || e.retryable;
        await updateRefund(r.id, retryable ? 'retry' : 'failed', undefined, (e as Error).message).catch((err) =>
            console.error('Failed to record refund outcome', r.id, err),
        );
    }
};

// Webhooks can be lost: ask Razorpay about orders that never reached a final state
const reconcilePayments = async (): Promise<void> => {
    for (const p of await listStalePayments(BATCH)) {
        try {
            for (const payment of await fetchOrderPayments(p.razorpay_order_id)) await applyGatewayPayment(payment);
        } catch (e) {
            console.error('Payment reconciliation failed', p.razorpay_order_id, (e as Error).message);
        }
        await markChecked(p.id);
    }
};

// Daily automatic payouts for venues on Razorpay Route
const runRoutePayouts = async (): Promise<void> => {
    for (const v of await venuesDueForRoutePayout(env.payouts.routeEveryHours)) {
        const payout = await startRoutePayout(v.venue_id, env.payouts.routeMinPaise);
        if (!payout) continue;
        try {
            const transfer = await createTransfer(v.razorpay_account_id, payout.amount_paise, payout.id);
            // processed now, or later via transfer.processed / transfer.failed webhook
            if (transfer.status === 'processed') await completePayout(payout.id, 'paid', transfer.id);
            else if (transfer.status === 'failed') await completePayout(payout.id, 'failed', transfer.id, 'Transfer failed');
            else await setPayoutTransferId(payout.id, transfer.id);
        } catch (e) {
            if (e instanceof RazorpayError && !e.retryable) {
                await completePayout(payout.id, 'failed', null, e.message);
            } else {
                // Unknown outcome (timeout / network): leave it processing for an admin to resolve, never pay twice
                console.error('Route payout outcome unknown, needs admin review', payout.id, (e as Error).message);
            }
        }
    }
};

export const runPaymentsTick = async (): Promise<void> => {
    if (!razorpayEnabled()) return;
    for (let batch = await claimRefunds(BATCH, LEASE_SECONDS); batch.length; batch = await claimRefunds(BATCH, LEASE_SECONDS)) {
        await Promise.all(batch.map(processRefund));
        if (batch.length < BATCH) break;
    }
    await reconcilePayments();
    await runRoutePayouts();
};
