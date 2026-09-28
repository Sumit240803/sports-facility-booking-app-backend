import type { Request, Response } from 'express';
import { z } from 'zod';
import {
    addFavourite,
    adminDashboard,
    deleteOwnReview,
    findReview,
    listFavourites,
    listMyReviews,
    listReviewsForAdmin,
    listVenueReviews,
    ratingBreakdown,
    removeFavourite,
    setOwnerReply,
    setReviewStatus,
    submitReview,
    venueDashboard,
} from '../models/engagement.model.js';
import { findPublicVenueSchedule, findVenueSchedule } from '../models/schedule.model.js';
import { notifyUser } from '../models/notification.model.js';
import { HttpError } from '../utils/http.js';
import { addDays, cleanText, isoDate, longText, pagination, parse, todayIn, uuidParam } from '../utils/validate.js';
import { UUID_RE } from '../utils/validation.js';

// Resolves :idOrSlug to a live, publicly visible venue id
const publicVenueId = async (key: string): Promise<string> => {
    const isId = UUID_RE.test(key);
    if (!isId && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) throw new HttpError(404, 'Venue not found');
    const venue = await findPublicVenueSchedule(isId ? { id: key } : { slug: key });
    if (!venue) throw new HttpError(404, 'Venue not found');
    return venue.id;
};

// ---------- Reviews: public ----------

const reviewListSchema = z.object({ sort: z.enum(['newest', 'highest', 'lowest']).default('newest'), ...pagination });

// GET /venues/:idOrSlug/reviews?sort=newest|highest|lowest
export const venueReviews = async (req: Request, res: Response): Promise<void> => {
    const venueId = await publicVenueId(String(req.params.idOrSlug ?? ''));
    const q = parse(reviewListSchema, req.query);
    const [list, breakdown] = await Promise.all([listVenueReviews(venueId, q.sort, q.limit, (q.page - 1) * q.limit), ratingBreakdown(venueId)]);
    res.set('Cache-Control', 'public, max-age=60');
    res.status(200).json({ ...list, breakdown, page: q.page, limit: q.limit });
};

// ---------- Reviews: player ----------

export const reviewSchema = z.strictObject({
    rating: z.number().int().min(1).max(5),
    comment: z.union([z.literal('').transform(() => null), z.null(), longText(1000)]).optional(),
});

// PUT /me/reviews/:venueId  { rating, comment? }  - create or update; requires having played there
export const upsertReview = async (req: Request, res: Response): Promise<void> => {
    const venueId = uuidParam(req.params.venueId, 'venue id');
    const body = parse(reviewSchema, req.body);
    const review = await submitReview(req.user!.id, venueId, body.rating, body.comment ?? null);
    res.status(200).json({ review });
};

// DELETE /me/reviews/:venueId
export const deleteReview = async (req: Request, res: Response): Promise<void> => {
    const ok = await deleteOwnReview(req.user!.id, uuidParam(req.params.venueId, 'venue id'));
    if (!ok) { res.status(404).json({ error: 'Review not found' }); return; }
    res.status(204).end();
};

// GET /me/reviews
export const myReviews = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ reviews: await listMyReviews(req.user!.id) });
};

// ---------- Reviews: venue team ----------

// GET /venues/:venueId/manage/reviews  (any staff) - includes hidden ones with the reason
export const manageReviews = async (req: Request, res: Response): Promise<void> => {
    const q = parse(reviewListSchema, req.query);
    const venueId = req.venueAccess!.venue.id;
    const [list, breakdown] = await Promise.all([listVenueReviews(venueId, q.sort, q.limit, (q.page - 1) * q.limit, true), ratingBreakdown(venueId)]);
    res.status(200).json({ ...list, breakdown, page: q.page, limit: q.limit });
};

export const replySchema = z.strictObject({ reply: cleanText(2, 1000) });

// PUT /venues/:venueId/reviews/:reviewId/reply  { reply }  (owner, manager)
export const replyToReview = async (req: Request, res: Response): Promise<void> => {
    const venue = req.venueAccess!.venue;
    const { reply } = parse(replySchema, req.body);
    const review = await findReview(venue.id, uuidParam(req.params.reviewId, 'review id'));
    if (!review) { res.status(404).json({ error: 'Review not found' }); return; }
    const updated = await setOwnerReply(review.id, reply, req.user!.id);
    await notifyUser(review.user_id, 'review_reply', `${venue.name} replied to your review`, reply.slice(0, 200), { venue_id: venue.id, review_id: review.id });
    res.status(200).json({ review: updated });
};

// DELETE /venues/:venueId/reviews/:reviewId/reply  (owner, manager)
export const deleteReply = async (req: Request, res: Response): Promise<void> => {
    const review = await findReview(req.venueAccess!.venue.id, uuidParam(req.params.reviewId, 'review id'));
    if (!review) { res.status(404).json({ error: 'Review not found' }); return; }
    res.status(200).json({ review: await setOwnerReply(review.id, null, req.user!.id) });
};

// ---------- Reviews: admin moderation ----------

const adminReviewListSchema = z.object({ status: z.enum(['visible', 'hidden']).optional(), ...pagination });

// GET /admin/reviews?status=hidden
export const adminReviews = async (req: Request, res: Response): Promise<void> => {
    const q = parse(adminReviewListSchema, req.query);
    res.status(200).json({ ...(await listReviewsForAdmin(q.status, q.limit, (q.page - 1) * q.limit)), page: q.page, limit: q.limit });
};

export const hideSchema = z.strictObject({ reason: cleanText(3, 500) });

// POST /admin/reviews/:reviewId/hide  { reason }
export const hideReview = async (req: Request, res: Response): Promise<void> => {
    const { reason } = parse(hideSchema, req.body);
    const review = await setReviewStatus(uuidParam(req.params.reviewId, 'review id'), 'hidden', reason);
    if (!review) { res.status(404).json({ error: 'Review not found' }); return; }
    res.status(200).json({ review });
};

// POST /admin/reviews/:reviewId/unhide
export const unhideReview = async (req: Request, res: Response): Promise<void> => {
    const review = await setReviewStatus(uuidParam(req.params.reviewId, 'review id'), 'visible', null);
    if (!review) { res.status(404).json({ error: 'Review not found' }); return; }
    res.status(200).json({ review });
};

// ---------- Favourites ----------

// GET /me/favourites
export const myFavourites = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ favourites: await listFavourites(req.user!.id) });
};

// PUT /me/favourites/:venueId  - idempotent; only live venues can be added
export const saveFavourite = async (req: Request, res: Response): Promise<void> => {
    const venueId = uuidParam(req.params.venueId, 'venue id');
    if (!(await findPublicVenueSchedule({ id: venueId }))) { res.status(404).json({ error: 'Venue not found' }); return; }
    await addFavourite(req.user!.id, venueId);
    res.status(204).end();
};

// DELETE /me/favourites/:venueId
export const unsaveFavourite = async (req: Request, res: Response): Promise<void> => {
    const ok = await removeFavourite(req.user!.id, uuidParam(req.params.venueId, 'venue id'));
    if (!ok) { res.status(404).json({ error: 'Not in favourites' }); return; }
    res.status(204).end();
};

// ---------- Dashboards ----------

const MAX_RANGE_DAYS = 366;
const rangeSchema = z
    .object({ from: isoDate.optional(), to: isoDate.optional() })
    .refine((q) => (q.from === undefined) === (q.to === undefined), 'from and to must be given together');

const resolveRange = (q: { from?: string | undefined; to?: string | undefined }, timeZone: string) => {
    const to = q.to ?? todayIn(timeZone);
    const from = q.from ?? addDays(to, -29); // default: last 30 days
    if (from > to) throw new HttpError(400, 'from must not be after to');
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    if (days > MAX_RANGE_DAYS) throw new HttpError(400, `Range can be at most ${MAX_RANGE_DAYS} days`);
    return { from, to };
};

// GET /venues/:venueId/dashboard?from=&to=  (owner, admin)
export const ownerDashboard = async (req: Request, res: Response): Promise<void> => {
    const venue = await findVenueSchedule(req.venueAccess!.venue.id);
    const { from, to } = resolveRange(parse(rangeSchema, req.query), venue!.timezone);
    res.status(200).json({ dashboard: await venueDashboard(venue!.id, from, to) });
};

// GET /admin/dashboard?from=&to=  (dates in Asia/Kolkata)
export const platformDashboard = async (req: Request, res: Response): Promise<void> => {
    const { from, to } = resolveRange(parse(rangeSchema, req.query), 'Asia/Kolkata');
    res.status(200).json({ dashboard: await adminDashboard(from, to) });
};
