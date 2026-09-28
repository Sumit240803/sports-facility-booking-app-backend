import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { findInvalidIds } from '../models/catalog.model.js';
import {
    ADMIN_VENUE_ACTIONS,
    createVenue,
    getManagedVenue,
    getPublicVenue,
    listMyVenues,
    listVenueCities,
    listVenuesForAdmin,
    searchVenues,
    softDeleteVenue,
    transitionVenue,
    updateVenue,
    VENUE_STATUSES,
    type VenueInput,
} from '../models/venue.model.js';
import { isFavourite } from '../models/engagement.model.js';
import { findVenueSchedule } from '../models/schedule.model.js';
import { HttpError } from '../utils/http.js';
import { cleanText, escapeLike, longText, pagination, parse, phoneSchema, slugId } from '../utils/validate.js';
import { UUID_RE } from '../utils/validation.js';

const MAX_VENUES_PER_OWNER = 50;
// Accepts canonical names and aliases (e.g. Asia/Kolkata, which some ICU builds list only as Asia/Calcutta)
const isValidTimeZone = (tz: string): boolean => {
    if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
};

// Optional text field: empty string clears it (null)
const optionalText = (schema: z.ZodType<string>) =>
    z.union([z.literal('').transform(() => null), z.null(), schema]).optional();

const venueFields = {
    description: optionalText(longText(2000)),
    phone: optionalText(phoneSchema),
    email: optionalText(z.email().max(254).transform((e) => e.toLowerCase())),
    address_line: optionalText(cleanText(5, 200)),
    locality: optionalText(cleanText(2, 100)),
    city: optionalText(cleanText(2, 60)),
    state: optionalText(cleanText(2, 60)),
    pincode: optionalText(z.string().trim().regex(/^[1-9][0-9]{5}$/, 'must be a 6-digit PIN code')),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    amenities: z.array(slugId).max(30).transform((a) => [...new Set(a)]).optional(),
    rules: optionalText(longText(2000)),
    timezone: z.string().max(64).refine(isValidTimeZone, 'must be a valid IANA time zone, e.g. Asia/Kolkata').optional(),
    // How many days ahead bookings open (1-7) and how far ahead slots are shown (up to 30)
    booking_window_days: z.number().int().min(1).max(7).optional(),
    listing_window_days: z.number().int().min(1).max(30).optional(),
    min_notice_minutes: z.number().int().min(0).max(1440).optional(),
    // Pay at venue: can be switched off; opens this many minutes before a slot
    pay_at_venue_enabled: z.boolean().optional(),
    pay_at_venue_window_minutes: z.number().int().min(15).max(720).optional(),
    // Refund tiers for player cancellations of paid bookings; [] = no refunds
    cancellation_policy: z
        .array(z.strictObject({ hours_before: z.number().int().min(0).max(168), refund_percent: z.number().int().min(0).max(100) }))
        .max(5)
        .transform((tiers) => [...tiers].sort((a, b) => b.hours_before - a.hours_before))
        .refine((tiers) => new Set(tiers.map((t) => t.hours_before)).size === tiers.length, 'hours_before values must be unique')
        .refine(
            (tiers) => tiers.every((t, i) => i === 0 || t.refund_percent <= tiers[i - 1]!.refund_percent),
            'Refunds cannot increase as the game gets closer',
        )
        .optional(),
};

const windowsValid = (v: { booking_window_days?: number | undefined; listing_window_days?: number | undefined }) =>
    v.booking_window_days === undefined || v.listing_window_days === undefined || v.listing_window_days >= v.booking_window_days;
const WINDOW_ERROR = { message: 'listing_window_days must be at least booking_window_days', path: ['listing_window_days'] };

const latLngTogether = (v: { lat?: number | null | undefined; lng?: number | null | undefined }) =>
    (v.lat === undefined) === (v.lng === undefined) && (v.lat === null) === (v.lng === null);
const LATLNG_ERROR = { message: 'lat and lng must be provided (or cleared) together', path: ['lat'] };

export const createSchema = z.strictObject({ name: cleanText(2, 100), ...venueFields }).refine(latLngTogether, LATLNG_ERROR).refine(windowsValid, WINDOW_ERROR);
export const updateSchema = z
    .strictObject({ name: cleanText(2, 100).optional(), ...venueFields })
    .refine(latLngTogether, LATLNG_ERROR)
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const reasonSchema = z.strictObject({ reason: cleanText(3, 500).optional() });

const validateAmenities = async (amenities: string[] | undefined) => {
    if (!amenities?.length) return;
    const invalid = await findInvalidIds('amenities', amenities);
    if (invalid.length) throw new HttpError(400, `Unknown amenities: ${invalid.join(', ')}`);
};

// ---------- Public ----------

export const searchSchema = z
    .object({
        city: cleanText(2, 60).optional(),
        sport: slugId.optional(),
        q: cleanText(1, 60).optional(),
        amenities: z
            .string()
            .transform((s) => [...new Set(s.split(',').map((a) => a.trim()).filter(Boolean))])
            .pipe(z.array(slugId).max(30))
            .optional(),
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        radius_km: z.coerce.number().min(1).max(100).optional(),
        sort: z.enum(['name', 'distance', 'newest', 'rating']).optional(),
        min_rating: z.coerce.number().min(1).max(5).optional(),
        ...pagination,
    })
    .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'lat and lng must be provided together', path: ['lat'] })
    .refine((v) => v.radius_km === undefined || v.lat !== undefined, { message: 'radius_km requires lat and lng', path: ['radius_km'] })
    .refine((v) => v.sort !== 'distance' || v.lat !== undefined, { message: 'sort=distance requires lat and lng', path: ['sort'] });

// GET /venues?city=&sport=&q=&amenities=a,b&lat=&lng=&radius_km=&sort=&page=&limit=
export const search = async (req: Request, res: Response): Promise<void> => {
    const p = parse(searchSchema, req.query);
    const { total, venues } = await searchVenues({
        city: p.city,
        sport: p.sport,
        q: p.q === undefined ? undefined : escapeLike(p.q),
        amenities: p.amenities,
        lat: p.lat,
        lng: p.lng,
        radiusKm: p.radius_km,
        sort: p.sort ?? (p.lat !== undefined ? 'distance' : 'name'),
        minRating: p.min_rating,
        limit: p.limit,
        offset: (p.page - 1) * p.limit,
    });
    res.set('Cache-Control', 'public, max-age=30');
    res.status(200).json({ venues, page: p.page, limit: p.limit, total });
};

// GET /venues/cities
export const cities = async (_req: Request, res: Response): Promise<void> => {
    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json({ cities: await listVenueCities() });
};

// GET /venues/:idOrSlug  (live venues only)
export const getPublic = async (req: Request, res: Response): Promise<void> => {
    const key = String(req.params.idOrSlug ?? '');
    const isId = UUID_RE.test(key);
    if (!isId && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) { res.status(404).json({ error: 'Venue not found' }); return; }

    const venue = await getPublicVenue(isId ? { id: key } : { slug: key });
    if (!venue) { res.status(404).json({ error: 'Venue not found' }); return; }
    if (req.user) {
        // Personalised response: must not be cached by shared caches
        res.set('Cache-Control', 'private, no-store');
        res.status(200).json({ venue: { ...venue, is_favourite: await isFavourite(req.user.id, venue.id as string) } });
        return;
    }
    res.set('Cache-Control', 'public, max-age=30');
    res.status(200).json({ venue });
};

// ---------- Owner / staff ----------

// GET /venues/mine  - venues I own and venues where I'm staff
export const mine = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json(await listMyVenues(req.user!.id));
};

// POST /venues  (venue_owner / admin)
export const create = async (req: Request, res: Response): Promise<void> => {
    const input = parse(createSchema, req.body);
    await validateAmenities(input.amenities);

    const { count, error } = await supabaseAdmin
        .from('venues')
        .select('id', { count: 'exact', head: true })
        .eq('owner_id', req.user!.id)
        .is('deleted_at', null);
    if (error) throw error;
    if ((count ?? 0) >= MAX_VENUES_PER_OWNER) {
        res.status(409).json({ error: `You can have at most ${MAX_VENUES_PER_OWNER} venues` });
        return;
    }

    const venue = await createVenue(req.user!.id, input as VenueInput & { name: string });
    res.status(201).json({ venue });
};

// GET /venues/:venueId/manage  (owner, admin, any staff)
export const getManaged = async (req: Request, res: Response): Promise<void> => {
    const venue = await getManagedVenue(req.venueAccess!.venue.id);
    if (!venue) { res.status(404).json({ error: 'Venue not found' }); return; }
    res.status(200).json({ venue, access: req.venueAccess!.role });
};

// PATCH /venues/:venueId  (owner, admin)
export const update = async (req: Request, res: Response): Promise<void> => {
    const changes = parse(updateSchema, req.body);
    await validateAmenities(changes.amenities);
    if (changes.booking_window_days !== undefined || changes.listing_window_days !== undefined) {
        const current = await findVenueSchedule(req.venueAccess!.venue.id);
        if (!windowsValid({ ...current!, ...changes })) throw new HttpError(400, WINDOW_ERROR.message);
    }
    const venue = await updateVenue(req.venueAccess!.venue.id, changes as VenueInput);
    res.status(200).json({ venue });
};

// DELETE /venues/:venueId  (owner, admin) - soft delete, kept for history
export const remove = async (req: Request, res: Response): Promise<void> => {
    await softDeleteVenue(req.venueAccess!.venue.id);
    res.status(204).end();
};

// POST /venues/:venueId/submit, /unpublish  (owner, admin)
export const ownerAction = (action: 'submit' | 'unpublish') => async (req: Request, res: Response): Promise<void> => {
    const venue = await transitionVenue(req.venueAccess!.venue.id, action, req.user!.id);
    res.status(200).json({ venue });
};

// ---------- Admin ----------

export const adminListSchema = z.object({
    status: z.enum(VENUE_STATUSES).optional(),
    city: cleanText(2, 60).optional(),
    ...pagination,
});

// GET /admin/venues?status=pending_review&city=&page=&limit=
export const adminList = async (req: Request, res: Response): Promise<void> => {
    const p = parse(adminListSchema, req.query);
    const { total, venues } = await listVenuesForAdmin(
        { status: p.status, city: p.city === undefined ? undefined : escapeLike(p.city) },
        p.limit,
        (p.page - 1) * p.limit,
    );
    res.status(200).json({ venues, page: p.page, limit: p.limit, total });
};

// POST /admin/venues/:venueId/approve|reject|suspend|reinstate  { reason? }
export const adminAction = (action: (typeof ADMIN_VENUE_ACTIONS)[number]) => async (req: Request, res: Response): Promise<void> => {
    const { reason } = parse(reasonSchema, req.body);
    const venue = await transitionVenue(req.venueAccess!.venue.id, action, req.user!.id, reason);
    res.status(200).json({ venue });
};
