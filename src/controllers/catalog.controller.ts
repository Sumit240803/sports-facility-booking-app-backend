import type { Request, Response } from 'express';
import { z } from 'zod';
import { createCatalogItem, listCatalog, updateCatalogItem, type CatalogTable } from '../models/catalog.model.js';
import { cleanText, parse, slugId } from '../utils/validate.js';

export const createSchema = z.strictObject({
    id: slugId,
    name: cleanText(2, 50),
    sort_order: z.number().int().min(0).max(10000).optional(),
});

export const updateSchema = z
    .strictObject({
        name: cleanText(2, 50).optional(),
        is_active: z.boolean().optional(),
        sort_order: z.number().int().min(0).max(10000).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const label = (table: CatalogTable) => (table === 'sports' ? 'Sport' : 'Amenity');

// GET /sports, GET /amenities  (public, active only)
export const listPublic = (table: CatalogTable) => async (_req: Request, res: Response): Promise<void> => {
    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json({ [table]: await listCatalog(table) });
};

// GET /admin/sports, GET /admin/amenities  (includes inactive)
export const listAll = (table: CatalogTable) => async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ [table]: await listCatalog(table, true) });
};

// POST /admin/sports, POST /admin/amenities  { id, name, sort_order? }
export const create = (table: CatalogTable) => async (req: Request, res: Response): Promise<void> => {
    const input = parse(createSchema, req.body);
    try {
        const item = await createCatalogItem(table, input);
        res.status(201).json({ item });
    } catch (err) {
        if ((err as { code?: string }).code === '23505') {
            res.status(409).json({ error: `${label(table)} with this id or name already exists` });
            return;
        }
        throw err;
    }
};

// PATCH /admin/sports/:id, PATCH /admin/amenities/:id  { name?, is_active?, sort_order? }
export const update = (table: CatalogTable) => async (req: Request, res: Response): Promise<void> => {
    const id = parse(slugId, req.params.id);
    const changes = parse(updateSchema, req.body);
    try {
        const item = await updateCatalogItem(table, id, changes);
        if (!item) { res.status(404).json({ error: `${label(table)} not found` }); return; }
        res.status(200).json({ item });
    } catch (err) {
        if ((err as { code?: string }).code === '23505') {
            res.status(409).json({ error: `${label(table)} with this name already exists` });
            return;
        }
        throw err;
    }
};
