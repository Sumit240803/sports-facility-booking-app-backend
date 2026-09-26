import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http.js';

export const razorpayEnabled = (): boolean => Boolean(env.razorpay.keyId && env.razorpay.keySecret);

export class RazorpayError extends Error {
    constructor(message: string, public status: number, public code?: string) {
        super(message);
    }
    // 429 / 5xx / network problems are worth retrying; other 4xx are not
    get retryable(): boolean {
        return this.status === 0 || this.status === 429 || this.status >= 500;
    }
}

const call = async <T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> => {
    if (!razorpayEnabled()) throw new HttpError(503, 'Online payments are not configured');
    const auth = Buffer.from(`${env.razorpay.keyId}:${env.razorpay.keySecret}`).toString('base64');
    let res: globalThis.Response;
    try {
        res = await fetch(`${env.razorpay.apiBase}${path}`, {
            method,
            headers: { authorization: `Basic ${auth}`, ...(body ? { 'content-type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (e) {
        throw new RazorpayError(`Razorpay unreachable: ${(e as Error).message}`, 0);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
        throw new RazorpayError(json?.error?.description ?? `Razorpay ${res.status}`, res.status, json?.error?.code);
    }
    return json as T;
};

// ---------- Signatures ----------

const safeEqualHex = (a: string, b: string): boolean => {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && timingSafeEqual(ab, bb);
};

// Checkout success handler signature: HMAC_SHA256(order_id|payment_id, key_secret)
export const verifyCheckoutSignature = (orderId: string, paymentId: string, signature: string): boolean =>
    safeEqualHex(createHmac('sha256', env.razorpay.keySecret!).update(`${orderId}|${paymentId}`).digest('hex'), signature);

// Webhook signature: HMAC_SHA256(raw body, webhook_secret)
export const verifyWebhookSignature = (rawBody: Buffer, signature: string): boolean =>
    Boolean(env.razorpay.webhookSecret)
    && safeEqualHex(createHmac('sha256', env.razorpay.webhookSecret!).update(rawBody).digest('hex'), signature);

// ---------- API ----------

export interface RzpOrder { id: string; amount: number; currency: string; status: string; receipt: string }
export interface RzpPayment {
    id: string;
    order_id: string;
    amount: number;
    currency: string;
    status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
    method?: string;
    error_code?: string | null;
    error_description?: string | null;
}
export interface RzpRefund { id: string; payment_id: string; amount: number; status: 'pending' | 'processed' | 'failed'; notes?: Record<string, string> }
export interface RzpTransfer { id: string; status?: string }

export const createOrder = (amountPaise: number, receipt: string, notes: Record<string, string>) =>
    call<RzpOrder>('POST', '/orders', { amount: amountPaise, currency: 'INR', receipt, notes });

export const fetchPayment = (paymentId: string) => call<RzpPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);

export const fetchOrderPayments = async (orderId: string) =>
    (await call<{ items: RzpPayment[] }>('GET', `/orders/${encodeURIComponent(orderId)}/payments`)).items;

export const capturePayment = (paymentId: string, amountPaise: number) =>
    call<RzpPayment>('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency: 'INR' });

// Normal-speed refund (5-7 working days); our refund id goes in notes so retries can find it
export const createRefund = (paymentId: string, amountPaise: number, refundId: string) =>
    call<RzpRefund>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, {
        amount: amountPaise,
        speed: 'normal',
        notes: { refund_id: refundId },
        receipt: refundId.slice(0, 40),
    });

export const listPaymentRefunds = async (paymentId: string) =>
    (await call<{ items: RzpRefund[] }>('GET', `/payments/${encodeURIComponent(paymentId)}/refunds`)).items;

// Direct transfer from the platform balance to a venue's Route linked account
export const createTransfer = (accountId: string, amountPaise: number, payoutId: string) =>
    call<RzpTransfer>('POST', '/transfers', { account: accountId, amount: amountPaise, currency: 'INR', notes: { payout_id: payoutId } });
