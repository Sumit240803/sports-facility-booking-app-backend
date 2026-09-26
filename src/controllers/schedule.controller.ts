import type { Request, Response } from 'express';
import { z } from 'zod';
import { findCourt } from '../models/court.model.js';
import {
    createBlock,
    deleteBlock,
    findPublicVenueSchedule,
    findVenueSchedule,
    getAvailability,
    getPriceRules,
    getVenueHours,
    listBlocks,
    resetCourtHours,
    setHours,
    setPriceRules,
    type HoursRange,
    type PriceRuleInput,
    type VenueSchedule,
} from '../models/schedule.model.js';
import { HttpError } from '../utils/http.js';
import { addDays, cleanText, isoDate, parse, timeOfDay, todayIn, uuidParam } from '../utils/validate.js';
import { UUID_RE } from '../utils/validation.js';

const MIN_PRICE = 100; // ₹1
const MAX_PRICE = 100_000_000; // ₹10,00,000
const pricePaise = z.number().int().min(MIN_PRICE).max(MAX_PRICE);
const day = z.number().int().min(0).max(6);

// ---------- Opening hours ----------

// close <= open means the range closes after midnight; open == close means open 24 hours
export const hoursSchema = z.strictObject({
    hours: z
        .array(z.strictObject({ day, open: timeOfDay, close: timeOfDay }))
        .max(70)
        .transform((list) =>
            list.map(({ day: d, open, close }): HoursRange => {
                if (open === 1440) throw new HttpError(400, 'open must be before 24:00');
                const closeMin = close % 1440;
                return { day: d, start: open, end: closeMin > open ? closeMin : closeMin + 1440 };
            }),
        ),
});

// GET /venues/:venueId/hours  (any staff)
export const getHours = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json(await getVenueHours(req.venueAccess!.venue.id));
};

// PUT /venues/:venueId/hours  (owner, manager)
export const putVenueHours = async (req: Request, res: Response): Promise<void> => {
    const { hours } = parse(hoursSchema, req.body);
    await setHours(req.venueAccess!.venue.id, null, hours);
    res.status(200).json(await getVenueHours(req.venueAccess!.venue.id));
};

// PUT /venues/:venueId/courts/:courtId/hours  (owner, manager) - court stops following venue hours
export const putCourtHours = async (req: Request, res: Response): Promise<void> => {
    const courtId = uuidParam(req.params.courtId, 'court id');
    const { hours } = parse(hoursSchema, req.body);
    await setHours(req.venueAccess!.venue.id, courtId, hours);
    res.status(200).json(await getVenueHours(req.venueAccess!.venue.id));
};

// DELETE /venues/:venueId/courts/:courtId/hours  (owner, manager) - court follows venue hours again
export const deleteCourtHours = async (req: Request, res: Response): Promise<void> => {
    const courtId = uuidParam(req.params.courtId, 'court id');
    await resetCourtHours(req.venueAccess!.venue.id, courtId);
    res.status(200).json(await getVenueHours(req.venueAccess!.venue.id));
};

// ---------- Pricing ----------

export const pricingSchema = z.strictObject({
    rules: z
        .array(
            z
                .strictObject({
                    days: z.array(day).min(1).max(7).optional(),
                    date: isoDate.optional(),
                    start: timeOfDay,
                    end: timeOfDay,
                    price_per_hour_paise: pricePaise,
                })
                .refine((r) => (r.days === undefined) !== (r.date === undefined), 'each rule needs either days or date')
                .refine((r) => r.end > r.start && r.start < 1440, 'end must be after start (use 24:00 for midnight)'),
        )
        .max(100),
});

// GET /venues/:venueId/courts/:courtId/pricing  (any staff)
export const getPricing = async (req: Request, res: Response): Promise<void> => {
    const court = await findCourt(req.venueAccess!.venue.id, uuidParam(req.params.courtId, 'court id'));
    if (!court) { res.status(404).json({ error: 'Court not found' }); return; }
    res.status(200).json({ price_per_hour_paise: court.price_per_hour_paise, rules: await getPriceRules(court.id) });
};

// PUT /venues/:venueId/courts/:courtId/pricing  (owner, manager) - replaces all rules
export const putPricing = async (req: Request, res: Response): Promise<void> => {
    const venueId = req.venueAccess!.venue.id;
    const courtId = uuidParam(req.params.courtId, 'court id');
    const { rules } = parse(pricingSchema, req.body);

    const venue = await findVenueSchedule(venueId);
    const today = todayIn(venue!.timezone);
    const past = rules.find((r) => r.date && r.date < today);
    if (past) throw new HttpError(400, `Date rule ${past.date} is in the past`);

    const input: PriceRuleInput[] = rules.map((r) => ({
        days: r.days ? [...new Set(r.days)] : null,
        date: r.date ?? null,
        start: r.start,
        end: r.end,
        price: r.price_per_hour_paise,
    }));
    await setPriceRules(venueId, courtId, input);
    const court = await findCourt(venueId, courtId);
    res.status(200).json({ price_per_hour_paise: court?.price_per_hour_paise ?? null, rules: await getPriceRules(courtId) });
};

// ---------- Blocks / closures ----------

const MAX_BLOCK_MS = 62 * 24 * 60 * 60 * 1000;

export const blockSchema = z
    .strictObject({
        court_id: z.uuid().nullable().optional(),
        starts_at: z.iso.datetime({ offset: true }),
        ends_at: z.iso.datetime({ offset: true }),
        reason: z.union([z.literal('').transform(() => null), z.null(), cleanText(2, 200)]).optional(),
    })
    .refine((b) => Date.parse(b.ends_at) > Date.parse(b.starts_at), { message: 'ends_at must be after starts_at', path: ['ends_at'] })
    .refine((b) => Date.parse(b.ends_at) - Date.parse(b.starts_at) <= MAX_BLOCK_MS, { message: 'A block can be at most 62 days long', path: ['ends_at'] })
    .refine((b) => Date.parse(b.ends_at) > Date.now(), { message: 'Block must end in the future', path: ['ends_at'] });

const blockListSchema = z.object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
});

// GET /venues/:venueId/blocks?from=&to=  (any staff) - default: from now, next 60 days
export const getBlocks = async (req: Request, res: Response): Promise<void> => {
    const q = parse(blockListSchema, req.query);
    const from = q.from ?? new Date().toISOString();
    const to = q.to ?? new Date(Date.parse(from) + 60 * 24 * 60 * 60 * 1000).toISOString();
    if (Date.parse(to) <= Date.parse(from)) throw new HttpError(400, 'to must be after from');
    res.status(200).json({ blocks: await listBlocks(req.venueAccess!.venue.id, from, to) });
};

// POST /venues/:venueId/blocks  (any staff)  court_id omitted/null = whole venue closed
export const postBlock = async (req: Request, res: Response): Promise<void> => {
    const venueId = req.venueAccess!.venue.id;
    const input = parse(blockSchema, req.body);
    if (input.court_id && !(await findCourt(venueId, input.court_id))) { res.status(404).json({ error: 'Court not found' }); return; }

    const block = await createBlock(venueId, {
        court_id: input.court_id ?? null,
        starts_at: new Date(input.starts_at).toISOString(),
        ends_at: new Date(input.ends_at).toISOString(),
        reason: input.reason ?? null,
    }, req.user!.id);
    res.status(201).json({ block });
};

// DELETE /venues/:venueId/blocks/:blockId  (any staff)
export const removeBlock = async (req: Request, res: Response): Promise<void> => {
    const removed = await deleteBlock(req.venueAccess!.venue.id, uuidParam(req.params.blockId, 'block id'));
    if (!removed) { res.status(404).json({ error: 'Block not found' }); return; }
    res.status(204).end();
};

// ---------- Availability ----------

const availabilitySchema = z.object({ date: isoDate.optional(), court_id: z.uuid().optional() });

const availabilityResponse = async (venue: VenueSchedule, date: string, courtId: string | undefined) => {
    const today = todayIn(venue.timezone);
    return {
        date,
        timezone: venue.timezone,
        today,
        booking_window_days: venue.booking_window_days,
        listing_window_days: venue.listing_window_days,
        bookable_until: addDays(today, venue.booking_window_days - 1),
        listed_until: addDays(today, venue.listing_window_days - 1),
        min_notice_minutes: venue.min_notice_minutes,
        courts: await getAvailability(venue.id, date, courtId),
    };
};

// GET /venues/:idOrSlug/availability?date=YYYY-MM-DD&court_id=  (public, live venues)
export const publicAvailability = async (req: Request, res: Response): Promise<void> => {
    const key = String(req.params.idOrSlug ?? '');
    const q = parse(availabilitySchema, req.query);
    const isId = UUID_RE.test(key);
    const venue = isId || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)
        ? await findPublicVenueSchedule(isId ? { id: key } : { slug: key })
        : null;
    if (!venue) { res.status(404).json({ error: 'Venue not found' }); return; }

    const today = todayIn(venue.timezone);
    const date = q.date ?? today;
    const lastListed = addDays(today, venue.listing_window_days - 1);
    if (date < today || date > lastListed) {
        throw new HttpError(400, `date must be between ${today} and ${lastListed}`);
    }
    res.set('Cache-Control', 'no-store');
    res.status(200).json(await availabilityResponse(venue, date, q.court_id));
};

// GET /venues/:venueId/manage/availability?date=&court_id=  (any staff, any venue status, ±60 days)
export const manageAvailability = async (req: Request, res: Response): Promise<void> => {
    const q = parse(availabilitySchema, req.query);
    const venue = await findVenueSchedule(req.venueAccess!.venue.id);
    if (!venue) { res.status(404).json({ error: 'Venue not found' }); return; }

    const today = todayIn(venue.timezone);
    const date = q.date ?? today;
    if (date < addDays(today, -60) || date > addDays(today, 60)) throw new HttpError(400, 'date must be within 60 days of today');
    res.status(200).json(await availabilityResponse(venue, date, q.court_id));
};
