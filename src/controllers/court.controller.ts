import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { findInvalidIds } from '../models/catalog.model.js';
import { createCourt, findCourt, listCourts, updateCourt, type Court, type CourtInput } from '../models/court.model.js';
import { HttpError } from '../utils/http.js';
import { cleanText, parse, slugId, uuidParam } from '../utils/validate.js';

const MAX_COURTS_PER_VENUE = 50;

const courtFields = {
    sport_id: slugId,
    is_indoor: z.boolean(),
    surface: z.union([z.literal('').transform(() => null), z.null(), cleanText(2, 50)]),
    capacity: z.number().int().min(1).max(100).nullable(),
    base_slot_minutes: z.union([z.literal(30), z.literal(60)]),
    min_duration_minutes: z.number().int().min(30).max(720),
    max_duration_minutes: z.number().int().min(30).max(720),
    is_active: z.boolean(),
    sort_order: z.number().int().min(0).max(10000),
    // Base price per hour in paise (₹1 = 100); price rules can override it by day/time or date
    price_per_hour_paise: z.number().int().min(100).max(100_000_000).nullable(),
};

export const createSchema = z.strictObject({
    name: cleanText(1, 60),
    ...courtFields,
    is_indoor: courtFields.is_indoor.default(false),
    base_slot_minutes: courtFields.base_slot_minutes.default(60),
    is_active: courtFields.is_active.default(true),
    sort_order: courtFields.sort_order.default(0),
    surface: courtFields.surface.optional(),
    capacity: courtFields.capacity.optional(),
    min_duration_minutes: courtFields.min_duration_minutes.optional(),
    max_duration_minutes: courtFields.max_duration_minutes.optional(),
    price_per_hour_paise: courtFields.price_per_hour_paise.optional(),
});

export const updateSchema = z
    .strictObject({
        name: cleanText(1, 60).optional(),
        sport_id: courtFields.sport_id.optional(),
        is_indoor: courtFields.is_indoor.optional(),
        surface: courtFields.surface.optional(),
        capacity: courtFields.capacity.optional(),
        base_slot_minutes: courtFields.base_slot_minutes.optional(),
        min_duration_minutes: courtFields.min_duration_minutes.optional(),
        max_duration_minutes: courtFields.max_duration_minutes.optional(),
        is_active: courtFields.is_active.optional(),
        sort_order: courtFields.sort_order.optional(),
        price_per_hour_paise: courtFields.price_per_hour_paise.optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

type Durations = Pick<Court, 'base_slot_minutes' | 'min_duration_minutes' | 'max_duration_minutes'>;

// Same rules as the courts_duration_check constraint, with readable errors
const checkDurations = ({ base_slot_minutes: base, min_duration_minutes: min, max_duration_minutes: max }: Durations) => {
    if (min < base) throw new HttpError(400, `min_duration_minutes must be at least the slot length (${base})`);
    if (min % base !== 0 || max % base !== 0) throw new HttpError(400, `Durations must be multiples of ${base} minutes`);
    if (max < min) throw new HttpError(400, 'max_duration_minutes must be at least min_duration_minutes');
};

const checkSport = async (sportId: string | undefined) => {
    if (sportId && (await findInvalidIds('sports', [sportId])).length) throw new HttpError(400, `Unknown sport: ${sportId}`);
};

const nameTaken = (err: unknown) => (err as { code?: string }).code === '23505';

// GET /venues/:venueId/courts  (owner, admin, any staff) - includes inactive courts
export const list = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ courts: await listCourts(req.venueAccess!.venue.id) });
};

// POST /venues/:venueId/courts  (owner, admin)
export const create = async (req: Request, res: Response): Promise<void> => {
    const venueId = req.venueAccess!.venue.id;
    const input = parse(createSchema, req.body);
    const base = input.base_slot_minutes;
    const min = input.min_duration_minutes ?? Math.max(base, 60);
    const durations: Durations = { base_slot_minutes: base, min_duration_minutes: min, max_duration_minutes: input.max_duration_minutes ?? Math.max(min, 120) };
    checkDurations(durations);
    await checkSport(input.sport_id);

    const { count, error } = await supabaseAdmin.from('courts').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).is('deleted_at', null);
    if (error) throw error;
    if ((count ?? 0) >= MAX_COURTS_PER_VENUE) {
        res.status(409).json({ error: `A venue can have at most ${MAX_COURTS_PER_VENUE} courts` });
        return;
    }

    try {
        const court = await createCourt(venueId, { ...input, ...durations } as CourtInput);
        res.status(201).json({ court });
    } catch (err) {
        if (nameTaken(err)) { res.status(409).json({ error: 'A court with this name already exists at this venue' }); return; }
        throw err;
    }
};

// PATCH /venues/:venueId/courts/:courtId  (owner, admin)
export const update = async (req: Request, res: Response): Promise<void> => {
    const venueId = req.venueAccess!.venue.id;
    const courtId = uuidParam(req.params.courtId, 'court id');
    const changes = parse(updateSchema, req.body);

    const current = await findCourt(venueId, courtId);
    if (!current) { res.status(404).json({ error: 'Court not found' }); return; }

    checkDurations({ ...current, ...(changes as Partial<Durations>) });
    await checkSport(changes.sport_id);

    try {
        const court = await updateCourt(venueId, courtId, changes as CourtInput);
        if (!court) { res.status(404).json({ error: 'Court not found' }); return; }
        res.status(200).json({ court });
    } catch (err) {
        if (nameTaken(err)) { res.status(409).json({ error: 'A court with this name already exists at this venue' }); return; }
        throw err;
    }
};

// DELETE /venues/:venueId/courts/:courtId  (owner, admin) - soft delete
export const remove = async (req: Request, res: Response): Promise<void> => {
    const courtId = uuidParam(req.params.courtId, 'court id');
    const court = await updateCourt(req.venueAccess!.venue.id, courtId, { is_active: false, deleted_at: new Date().toISOString() });
    if (!court) { res.status(404).json({ error: 'Court not found' }); return; }
    res.status(204).end();
};
