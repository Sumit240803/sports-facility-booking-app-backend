import type { Request, Response } from 'express';
import {
    findOwnerApplication,
    listOwnerApplications,
    OWNER_VERIFICATION_STATUSES,
    reviewOwnerApplication,
    submitOwnerApplication,
    type OwnerVerificationStatus,
} from '../models/venueOwner.model.js';
import { GSTIN_RE, normalizePhone, PHONE_ERROR, PHONE_RE, readString, UUID_RE } from '../utils/validation.js';

// POST /owner-applications/me  { business_name, business_phone, gstin? }
export const applyAsOwner = async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    if (user.role !== 'player') { res.status(409).json({ error: 'You already have elevated access' }); return; }
    if (!user.onboarded_at) { res.status(400).json({ error: 'Complete your profile before applying' }); return; }

    const existing = await findOwnerApplication(user.id);
    if (existing && existing.verification_status !== 'rejected') {
        res.status(409).json({ error: `Application already ${existing.verification_status}` });
        return;
    }

    const businessName = readString(req.body?.business_name);
    const businessPhone = readString(req.body?.business_phone);
    const gstin = readString(req.body?.gstin)?.toUpperCase() ?? null;

    if (!businessName) { res.status(400).json({ error: 'business_name is required' }); return; }
    if (!businessPhone || !PHONE_RE.test(normalizePhone(businessPhone))) { res.status(400).json({ error: `business_phone: ${PHONE_ERROR}` }); return; }
    if (gstin && !GSTIN_RE.test(gstin)) { res.status(400).json({ error: 'Invalid GSTIN' }); return; }

    const application = await submitOwnerApplication(user.id, {
        business_name: businessName,
        business_phone: normalizePhone(businessPhone),
        gstin,
    });
    res.status(201).json({ application });
};

// GET /owner-applications/me
export const getMyApplication = async (req: Request, res: Response): Promise<void> => {
    const application = await findOwnerApplication(req.user!.id);
    if (!application) { res.status(404).json({ error: 'No application found' }); return; }
    res.status(200).json({ application });
};

// GET /admin/owner-applications?status=pending
export const listApplications = async (req: Request, res: Response): Promise<void> => {
    const status = req.query.status;
    if (status !== undefined && !OWNER_VERIFICATION_STATUSES.includes(status as OwnerVerificationStatus)) {
        res.status(400).json({ error: `status must be one of ${OWNER_VERIFICATION_STATUSES.join(', ')}` });
        return;
    }
    const applications = await listOwnerApplications(status as OwnerVerificationStatus | undefined);
    res.status(200).json({ applications });
};

const review = (approve: boolean) => async (req: Request, res: Response): Promise<void> => {
    const userId = req.params.userId;
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) { res.status(400).json({ error: 'Invalid user id' }); return; }

    const reason = readString(req.body?.reason);
    if (!approve && !reason) { res.status(400).json({ error: 'reason is required when rejecting' }); return; }

    const application = await reviewOwnerApplication(userId, req.user!.id, approve, reason);
    if (!application) { res.status(404).json({ error: 'No pending application for this user' }); return; }
    res.status(200).json({ application });
};

// POST /admin/owner-applications/:userId/approve
export const approveApplication = review(true);
// POST /admin/owner-applications/:userId/reject  { reason }
export const rejectApplication = review(false);
