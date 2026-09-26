import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
    capturePayment,
    createOrder,
    fetchPayment,
    RazorpayError,
    razorpayEnabled,
    verifyCheckoutSignature,
    verifyWebhookSignature,
    type RzpPayment,
} from '../lib/razorpay.js';
import { getUserBooking } from '../models/booking.model.js';
import {
    claimWebhookEvent,
    completePayout,
    findOpenOrder,
    findProcessingPayoutByTransfer,
    insertPaymentOrder,
    isUserBookingOrder,
    recordCaptured,
    recordFailed,
    releaseWebhookEvent,
    updateRefundByGatewayId,
    type CaptureOutcome,
} from '../models/payment.model.js';
import { HttpError } from '../utils/http.js';
import { parse, uuidParam } from '../utils/validate.js';

const requirePayments = () => {
    if (!razorpayEnabled()) throw new HttpError(503, 'Online payments are not configured');
};

// Applies a payment's current state from Razorpay (used by verify, webhooks and reconciliation)
export const applyGatewayPayment = async (p: RzpPayment): Promise<CaptureOutcome | null> => {
    if (p.status === 'authorized') {
        // Auto-capture is normally on; capture explicitly if it isn't
        const captured = await capturePayment(p.id, p.amount);
        return recordCaptured(captured.order_id, captured.id, captured.amount, captured.currency, captured.method ?? null);
    }
    if (p.status === 'captured' || p.status === 'refunded') {
        return recordCaptured(p.order_id, p.id, p.amount, p.currency, p.method ?? null);
    }
    if (p.status === 'failed') {
        await recordFailed(p.order_id, p.id, p.error_code ?? null, p.error_description ?? null);
    }
    return null;
};

// POST /me/bookings/:id/pay  - Razorpay order for a pending online booking (reused if one exists)
export const startPayment = async (req: Request, res: Response): Promise<void> => {
    requirePayments();
    const booking = await getUserBooking(req.user!.id, uuidParam(req.params.id, 'booking id'));
    if (!booking) { res.status(404).json({ error: 'Booking not found' }); return; }
    if (booking.status !== 'pending_payment' || booking.payment_method !== 'online') {
        res.status(409).json({ error: 'This booking is not waiting for payment' });
        return;
    }
    const secondsLeft = Math.floor((Date.parse(booking.expires_at!) - Date.now()) / 1000);
    if (secondsLeft < 30) { res.status(409).json({ error: 'The payment window for this booking has ended; please book again' }); return; }

    let orderId = (await findOpenOrder(booking.id, booking.total_paise))?.razorpay_order_id;
    if (!orderId) {
        const order = await createOrder(booking.total_paise, booking.reference, { booking_id: booking.id, reference: booking.reference });
        await insertPaymentOrder(booking.id, req.user!.id, order.id, booking.total_paise);
        orderId = order.id;
    }

    res.status(200).json({
        key_id: env.razorpay.keyId,
        order_id: orderId,
        amount_paise: booking.total_paise,
        currency: 'INR',
        booking_id: booking.id,
        reference: booking.reference,
        expires_at: booking.expires_at,
        // Pass as Razorpay Checkout `timeout` so checkout closes when the hold ends
        checkout_timeout_seconds: secondsLeft,
        description: `${(booking as unknown as { court: { name: string } }).court.name} at ${(booking as unknown as { venue: { name: string } }).venue.name}`,
        prefill: { name: req.user!.full_name, email: req.user!.email, contact: req.user!.phone },
    });
};

export const verifySchema = z.strictObject({
    razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]+$/),
    razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]+$/),
    razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/),
});

// POST /me/bookings/:id/pay/verify  - called by the app after Checkout succeeds
export const verifyPayment = async (req: Request, res: Response): Promise<void> => {
    requirePayments();
    const bookingId = uuidParam(req.params.id, 'booking id');
    const body = parse(verifySchema, req.body);
    if (!verifyCheckoutSignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
        res.status(400).json({ error: 'Invalid payment signature' });
        return;
    }

    // The order must belong to this user's booking
    if (!(await isUserBookingOrder(body.razorpay_order_id, bookingId, req.user!.id))) {
        res.status(404).json({ error: 'Payment not found for this booking' });
        return;
    }

    // Never trust the client for the amount/status: ask Razorpay
    const payment = await fetchPayment(body.razorpay_payment_id);
    if (payment.order_id !== body.razorpay_order_id) { res.status(400).json({ error: 'Payment does not belong to this order' }); return; }
    const result = await applyGatewayPayment(payment);

    const booking = await getUserBooking(req.user!.id, bookingId);
    res.status(200).json({ outcome: result?.outcome ?? payment.status, ...(result?.reason ? { refund_reason: result.reason } : {}), booking });
};

// ---------- Webhook ----------

interface WebhookBody {
    event: string;
    payload: {
        payment?: { entity: RzpPayment };
        refund?: { entity: { id: string; status: string } };
        transfer?: { entity: { id: string; status?: string; error?: { description?: string } } };
    };
}

// POST /payments/webhook  (raw body; signature in X-Razorpay-Signature)
export const webhook = async (req: Request, res: Response): Promise<void> => {
    const raw = req.body as Buffer;
    const signature = req.header('x-razorpay-signature') ?? '';
    if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(raw, signature)) {
        res.status(400).json({ error: 'Invalid signature' });
        return;
    }

    let body: WebhookBody;
    try {
        body = JSON.parse(raw.toString('utf8'));
    } catch {
        res.status(400).json({ error: 'Invalid JSON' });
        return;
    }

    const eventId = req.header('x-razorpay-event-id') || createHash('sha256').update(raw).digest('hex');
    if (!(await claimWebhookEvent(eventId, body.event))) {
        res.status(200).json({ status: 'duplicate' });
        return;
    }

    try {
        const payment = body.payload.payment?.entity;
        switch (body.event) {
            case 'payment.authorized':
            case 'payment.captured':
            case 'order.paid':
                // Re-read from Razorpay so an old/replayed payload can't regress state
                if (payment) await applyGatewayPayment(razorpayEnabled() ? await fetchPayment(payment.id) : payment);
                break;
            case 'payment.failed':
                if (payment) await recordFailed(payment.order_id, payment.id, payment.error_code ?? null, payment.error_description ?? null);
                break;
            case 'refund.processed':
            case 'refund.failed': {
                const refund = body.payload.refund?.entity;
                if (refund) await updateRefundByGatewayId(refund.id, body.event === 'refund.processed' ? 'processed' : 'failed', body.event === 'refund.failed' ? 'Refund failed at Razorpay' : undefined);
                break;
            }
            case 'transfer.processed':
            case 'transfer.failed': {
                const transfer = body.payload.transfer?.entity;
                if (!transfer) break;
                const payoutId = await findProcessingPayoutByTransfer(transfer.id);
                if (payoutId) await completePayout(payoutId, body.event === 'transfer.processed' ? 'paid' : 'failed', transfer.id, transfer.error?.description ?? null);
                break;
            }
            default:
                break; // events we don't use
        }
        res.status(200).json({ status: 'ok' });
    } catch (err) {
        // Let Razorpay retry: forget the event id so the retry is processed
        await releaseWebhookEvent(eventId);
        if (err instanceof RazorpayError) console.error('Webhook: Razorpay call failed', err.message);
        throw err;
    }
};
