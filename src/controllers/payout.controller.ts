import type { Request, Response } from 'express';
import { z } from 'zod';
import {
    addAdjustment,
    completePayout,
    getPayoutSettings,
    listBalances,
    listLedger,
    listPayouts,
    listRefunds,
    recordManualPayout,
    retryRefund,
    upsertPayoutSettings,
    venueBalance,
    type PayoutSettings,
} from '../models/payment.model.js';
import { HttpError } from '../utils/http.js';
import { cleanText, pagination, parse, uuidParam } from '../utils/validate.js';

const COMMISSION_PERCENT = 10; // mirrors platform_commission_percent() in SQL

const mask = (s: PayoutSettings | null) =>
    s && { ...s, bank_account_number: s.bank_account_number ? `••••${s.bank_account_number.slice(-4)}` : null };

// ---------- Owner ----------

// GET /venues/:venueId/earnings?page=&limit=  (owner, admin)
export const earnings = async (req: Request, res: Response): Promise<void> => {
    const venueId = req.venueAccess!.venue.id;
    const q = parse(z.object(pagination), req.query);
    const [balance, ledger, payouts, settings] = await Promise.all([
        venueBalance(venueId),
        listLedger(venueId, q.limit, (q.page - 1) * q.limit),
        listPayouts({ venueId }, 20, 0),
        getPayoutSettings(venueId),
    ]);
    res.status(200).json({
        balance_paise: balance,
        commission_percent: COMMISSION_PERCENT,
        payout_mode: settings?.mode ?? 'manual',
        ledger: ledger.entries,
        ledger_total: ledger.total,
        recent_payouts: payouts.payouts,
        page: q.page,
        limit: q.limit,
    });
};

// GET /venues/:venueId/payout-settings  (owner, admin) - bank account masked
export const getSettings = async (req: Request, res: Response): Promise<void> => {
    const settings = await getPayoutSettings(req.venueAccess!.venue.id);
    res.status(200).json({ settings: mask(settings) ?? { venue_id: req.venueAccess!.venue.id, mode: 'manual' } });
};

const optional = <T extends z.ZodType>(s: T) => z.union([z.literal('').transform(() => null), z.null(), s]).optional();

export const settingsSchema = z
    .strictObject({
        mode: z.enum(['manual', 'route']).optional(),
        account_holder_name: optional(cleanText(2, 100)),
        bank_account_number: optional(z.string().regex(/^[0-9]{9,18}$/, 'must be 9-18 digits')),
        bank_ifsc: optional(z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'must be a valid IFSC'))),
        upi_id: optional(z.string().trim().regex(/^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,64}$/, 'must be a valid UPI id')),
    })
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// PUT /venues/:venueId/payout-settings  (owner, admin)
export const putSettings = async (req: Request, res: Response): Promise<void> => {
    const venueId = req.venueAccess!.venue.id;
    const changes = parse(settingsSchema, req.body);
    const current = await getPayoutSettings(venueId);
    const next = { mode: 'manual', razorpay_account_id: null, account_holder_name: null, bank_account_number: null, bank_ifsc: null, upi_id: null, ...current, ...changes };

    if (next.mode === 'route' && !next.razorpay_account_id) {
        throw new HttpError(409, 'Automatic payouts need your Razorpay linked account to be set up by EasyPlay first');
    }
    if (next.mode === 'manual') {
        const bank = [next.account_holder_name, next.bank_account_number, next.bank_ifsc];
        const hasBank = bank.every(Boolean);
        if (bank.some(Boolean) && !hasBank) throw new HttpError(400, 'Bank details need account holder name, account number and IFSC together');
        if (!hasBank && !next.upi_id) throw new HttpError(400, 'Manual payouts need bank details or a UPI id');
    }

    const saved = await upsertPayoutSettings(venueId, changes as Partial<PayoutSettings>, req.user!.id);
    res.status(200).json({ settings: mask(saved) });
};

// ---------- Admin ----------

// GET /admin/payouts/balances
export const balances = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ venues: await listBalances() });
};

// GET /admin/venues/:venueId/payout-settings  (full bank details for manual transfers)
export const adminGetSettings = async (req: Request, res: Response): Promise<void> => {
    const venueId = req.venueAccess!.venue.id;
    const [settings, balance] = await Promise.all([getPayoutSettings(venueId), venueBalance(venueId)]);
    res.status(200).json({ settings, balance_paise: balance });
};

export const linkedAccountSchema = z.strictObject({
    razorpay_account_id: z.union([z.null(), z.string().regex(/^acc_[A-Za-z0-9]{6,32}$/, 'must look like acc_XXXXXXXX')]),
});

// PUT /admin/venues/:venueId/payout-settings  { razorpay_account_id }  - after Route onboarding in Razorpay
export const adminSetLinkedAccount = async (req: Request, res: Response): Promise<void> => {
    const venueId = req.venueAccess!.venue.id;
    const { razorpay_account_id } = parse(linkedAccountSchema, req.body);
    const current = await getPayoutSettings(venueId);
    // Removing the linked account switches the venue back to manual payouts
    const changes = razorpay_account_id === null && current?.mode === 'route'
        ? { razorpay_account_id, mode: 'manual' as const }
        : { razorpay_account_id };
    res.status(200).json({ settings: await upsertPayoutSettings(venueId, changes, req.user!.id) });
};

const paise = z.number().int().min(1).max(1_000_000_000);

export const manualPayoutSchema = z.strictObject({
    amount_paise: paise,
    reference: cleanText(3, 100),
    note: z.union([z.null(), cleanText(2, 500)]).optional(),
});

// POST /admin/venues/:venueId/payouts  { amount_paise, reference (UTR), note? }  - record a manual transfer
export const createManualPayout = async (req: Request, res: Response): Promise<void> => {
    const body = parse(manualPayoutSchema, req.body);
    const payout = await recordManualPayout(req.venueAccess!.venue.id, body.amount_paise, body.reference, body.note ?? null, req.user!.id);
    res.status(201).json({ payout, balance_paise: await venueBalance(req.venueAccess!.venue.id) });
};

export const adjustmentSchema = z.strictObject({
    amount_paise: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine((n) => n !== 0, 'must not be 0'),
    note: cleanText(3, 500),
});

// POST /admin/venues/:venueId/adjustments  { amount_paise (+ credit / - debit), note }
export const createAdjustment = async (req: Request, res: Response): Promise<void> => {
    const body = parse(adjustmentSchema, req.body);
    const entry = await addAdjustment(req.venueAccess!.venue.id, body.amount_paise, body.note, req.user!.id);
    res.status(201).json({ entry, balance_paise: await venueBalance(req.venueAccess!.venue.id) });
};

const payoutListSchema = z.object({
    status: z.enum(['processing', 'paid', 'failed']).optional(),
    venue_id: z.uuid().optional(),
    ...pagination,
});

// GET /admin/payouts?status=processing&venue_id=
export const adminPayouts = async (req: Request, res: Response): Promise<void> => {
    const q = parse(payoutListSchema, req.query);
    const result = await listPayouts({ ...(q.venue_id ? { venueId: q.venue_id } : {}), ...(q.status ? { status: q.status } : {}) }, q.limit, (q.page - 1) * q.limit);
    res.status(200).json({ ...result, page: q.page, limit: q.limit });
};

export const resolveSchema = z
    .strictObject({
        status: z.enum(['paid', 'failed']),
        razorpay_transfer_id: z.string().regex(/^trf_[A-Za-z0-9]+$/).optional(),
        reason: cleanText(3, 500).optional(),
    })
    .refine((v) => v.status !== 'failed' || v.reason, { message: 'reason is required when marking failed', path: ['reason'] });

// POST /admin/payouts/:payoutId/resolve  - settle a payout stuck in processing (after checking Razorpay)
export const resolvePayout = async (req: Request, res: Response): Promise<void> => {
    const body = parse(resolveSchema, req.body);
    const payout = await completePayout(uuidParam(req.params.payoutId, 'payout id'), body.status, body.razorpay_transfer_id, body.reason, req.user!.id);
    res.status(200).json({ payout });
};

const refundListSchema = z.object({ status: z.enum(['pending', 'processing', 'processed', 'failed']).optional(), ...pagination });

// GET /admin/refunds?status=failed
export const adminRefunds = async (req: Request, res: Response): Promise<void> => {
    const q = parse(refundListSchema, req.query);
    res.status(200).json({ ...(await listRefunds(q.status, q.limit, (q.page - 1) * q.limit)), page: q.page, limit: q.limit });
};

// POST /admin/refunds/:refundId/retry
export const adminRetryRefund = async (req: Request, res: Response): Promise<void> => {
    const ok = await retryRefund(uuidParam(req.params.refundId, 'refund id'));
    if (!ok) { res.status(409).json({ error: 'Only failed refunds can be retried' }); return; }
    res.status(204).end();
};
