import type { Request, Response } from 'express';
import { z } from 'zod';
import {
    BOOKING_STATUSES,
    cancelBooking,
    checkInBooking,
    collectPayment,
    createBooking,
    getUserBooking,
    getVenueBooking,
    listUserBookings,
    listVenueBookings,
    markNoShow,
    quoteBooking,
    undoNoShow,
    type BookingRequest,
    type BookingStatus,
} from '../models/booking.model.js';
import { findCourt } from '../models/court.model.js';
import { findVenueSchedule } from '../models/schedule.model.js';
import { HttpError } from '../utils/http.js';
import { addDays, cleanText, isoDate, pagination, parse, phoneSchema, todayIn, uuidParam } from '../utils/validate.js';

const bookingFields = {
    court_id: z.uuid(),
    date: isoDate,
    start: z.iso.datetime({ offset: true }),
    duration_minutes: z.number().int().min(30).max(720),
};

const toRequest = (b: { court_id: string; date: string; start: string; duration_minutes: number }, method: BookingRequest['method']): BookingRequest => ({
    courtId: b.court_id,
    date: b.date,
    start: new Date(b.start).toISOString(),
    durationMinutes: b.duration_minutes,
    method,
});

const reasonText = z.union([z.literal('').transform(() => null), z.null(), cleanText(3, 500)]).optional();

// Players must have finished onboarding (name + phone) so the venue can reach them
const requireOnboarded = (req: Request) => {
    if (!req.user!.onboarded_at) throw new HttpError(400, 'Complete your profile (name, phone, city) before booking');
};

// ---------- Player ----------

export const playerBookingSchema = z.strictObject({
    ...bookingFields,
    payment_method: z.enum(['online', 'pay_at_venue']),
    notes: reasonText,
});

// POST /bookings/quote  - validates and prices without booking
export const quote = async (req: Request, res: Response): Promise<void> => {
    const body = parse(playerBookingSchema.omit({ notes: true }), req.body);
    res.status(200).json({ quote: await quoteBooking(req.user!.id, toRequest(body, body.payment_method)) });
};

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

// POST /bookings  (header Idempotency-Key recommended)
export const create = async (req: Request, res: Response): Promise<void> => {
    requireOnboarded(req);
    const body = parse(playerBookingSchema, req.body);
    const key = req.header('idempotency-key');
    if (key !== undefined && !IDEMPOTENCY_KEY_RE.test(key)) throw new HttpError(400, 'Idempotency-Key must be 8-100 letters, digits, - or _');

    const booking = await createBooking(req.user!.id, req.user!.id, toRequest(body, body.payment_method), {
        notes: body.notes ?? null,
        idempotencyKey: key ?? null,
    });
    res.status(201).json({ booking });
};

const myListSchema = z.object({ scope: z.enum(['upcoming', 'past']).default('upcoming'), ...pagination });

// GET /me/bookings?scope=upcoming|past
export const myBookings = async (req: Request, res: Response): Promise<void> => {
    const q = parse(myListSchema, req.query);
    const result = await listUserBookings(req.user!.id, q.scope, q.limit, (q.page - 1) * q.limit);
    res.status(200).json({ ...result, page: q.page, limit: q.limit });
};

// GET /me/bookings/:id
export const myBooking = async (req: Request, res: Response): Promise<void> => {
    const booking = await getUserBooking(req.user!.id, uuidParam(req.params.id, 'booking id'));
    if (!booking) { res.status(404).json({ error: 'Booking not found' }); return; }
    res.status(200).json({ booking });
};

// POST /me/bookings/:id/cancel  { reason? }
export const cancelMine = async (req: Request, res: Response): Promise<void> => {
    const { reason } = parse(z.strictObject({ reason: reasonText }), req.body);
    const booking = await cancelBooking(uuidParam(req.params.id, 'booking id'), req.user!.id, 'player', reason);
    res.status(200).json({ booking });
};

// ---------- Venue staff ----------

export const offlineBookingSchema = z.strictObject({
    ...bookingFields,
    customer_name: cleanText(2, 100),
    customer_phone: phoneSchema,
    notes: reasonText,
});

// POST /venues/:venueId/bookings  (any staff) - walk-in / phone booking, paid at the venue
export const createOffline = async (req: Request, res: Response): Promise<void> => {
    const body = parse(offlineBookingSchema, req.body);
    const request = toRequest(body, 'offline');
    // The court must belong to this venue
    if (!(await findCourt(req.venueAccess!.venue.id, request.courtId))) { res.status(404).json({ error: 'Court not found' }); return; }

    const booking = await createBooking(null, req.user!.id, request, {
        customerName: body.customer_name,
        customerPhone: body.customer_phone,
        notes: body.notes ?? null,
    });
    res.status(201).json({ booking });
};

const venueListSchema = z
    .object({
        date: isoDate.optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        status: z
            .string()
            .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
            .pipe(z.array(z.enum(BOOKING_STATUSES)))
            .optional(),
    })
    .refine((q) => !(q.date && (q.from || q.to)), 'Use either date or from/to')
    .refine((q) => (q.from === undefined) === (q.to === undefined), 'from and to must be given together');

// GET /venues/:venueId/bookings?date=YYYY-MM-DD | from=&to= &status=confirmed,checked_in  (any staff)
export const venueBookings = async (req: Request, res: Response): Promise<void> => {
    const q = parse(venueListSchema, req.query);
    const venue = await findVenueSchedule(req.venueAccess!.venue.id);
    let from: string;
    let to: string;
    if (q.from && q.to) {
        from = new Date(q.from).toISOString();
        to = new Date(q.to).toISOString();
        if (Date.parse(to) <= Date.parse(from)) throw new HttpError(400, 'to must be after from');
        if (Date.parse(to) - Date.parse(from) > 31 * 86_400_000) throw new HttpError(400, 'Range can be at most 31 days');
    } else {
        // A local calendar day in the venue's timezone (bookings that overlap it)
        const date = q.date ?? todayIn(venue!.timezone);
        from = localMidnight(date, venue!.timezone);
        to = localMidnight(addDays(date, 1), venue!.timezone);
    }
    res.status(200).json({ from, to, bookings: await listVenueBookings(req.venueAccess!.venue.id, from, to, q.status as BookingStatus[] | undefined) });
};

// UTC instant of 00:00 local time on a date in a timezone
const localMidnight = (date: string, timeZone: string): string => {
    const guess = Date.parse(`${date}T00:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    return new Date(guess - (asLocal - guess)).toISOString();
};

// GET /venues/:venueId/bookings/:bookingId  (any staff) - includes status history
export const venueBooking = async (req: Request, res: Response): Promise<void> => {
    const booking = await getVenueBooking(req.venueAccess!.venue.id, { id: uuidParam(req.params.bookingId, 'booking id') });
    if (!booking) { res.status(404).json({ error: 'Booking not found' }); return; }
    res.status(200).json({ booking });
};

// GET /venues/:venueId/bookings/by-reference/:reference  (any staff) - for QR / typed check-in
export const venueBookingByReference = async (req: Request, res: Response): Promise<void> => {
    const ref = String(req.params.reference ?? '').trim().toUpperCase();
    if (!/^EP-[2-9A-HJ-KMNP-Z]{6}$/.test(ref)) { res.status(404).json({ error: 'Booking not found' }); return; }
    const booking = await getVenueBooking(req.venueAccess!.venue.id, { reference: ref });
    if (!booking) { res.status(404).json({ error: 'Booking not found' }); return; }
    res.status(200).json({ booking });
};

const paise = z.number().int().min(0).max(100_000_000);

// POST /venues/:venueId/bookings/:bookingId/check-in  { collected_paise? }  (any staff)
export const checkIn = async (req: Request, res: Response): Promise<void> => {
    const { collected_paise } = parse(z.strictObject({ collected_paise: paise.optional() }), req.body);
    const booking = await checkInBooking(uuidParam(req.params.bookingId, 'booking id'), req.venueAccess!.venue.id, req.user!.id, collected_paise);
    res.status(200).json({ booking });
};

// POST /venues/:venueId/bookings/:bookingId/collect  { amount_paise }  (any staff)
export const collect = async (req: Request, res: Response): Promise<void> => {
    const { amount_paise } = parse(z.strictObject({ amount_paise: paise }), req.body);
    const booking = await collectPayment(uuidParam(req.params.bookingId, 'booking id'), req.venueAccess!.venue.id, req.user!.id, amount_paise);
    res.status(200).json({ booking });
};

// POST /venues/:venueId/bookings/:bookingId/no-show  (any staff)
export const noShow = async (req: Request, res: Response): Promise<void> => {
    const booking = await markNoShow(uuidParam(req.params.bookingId, 'booking id'), req.venueAccess!.venue.id, req.user!.id);
    res.status(200).json({ booking });
};

// POST /venues/:venueId/bookings/:bookingId/undo-no-show  (any staff)
export const undoNoShowBooking = async (req: Request, res: Response): Promise<void> => {
    const booking = await undoNoShow(uuidParam(req.params.bookingId, 'booking id'), req.venueAccess!.venue.id, req.user!.id);
    res.status(200).json({ booking });
};

// POST /venues/:venueId/bookings/:bookingId/cancel  { reason }  (owner, manager) - full refund of anything paid
export const cancelByVenue = async (req: Request, res: Response): Promise<void> => {
    const { reason } = parse(z.strictObject({ reason: cleanText(3, 500) }), req.body);
    const bookingId = uuidParam(req.params.bookingId, 'booking id');
    const existing = await getVenueBooking(req.venueAccess!.venue.id, { id: bookingId });
    if (!existing) { res.status(404).json({ error: 'Booking not found' }); return; }
    const role = req.venueAccess!.role === 'admin' ? 'admin' : 'venue';
    const booking = await cancelBooking(bookingId, req.user!.id, role, reason);
    res.status(200).json({ booking });
};
