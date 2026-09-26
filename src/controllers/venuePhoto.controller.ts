import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { addPhoto, deletePhoto, listPhotos, reorderPhotos, setCover } from '../models/venuePhoto.model.js';
import { parse, uuidParam } from '../utils/validate.js';

// Raw upload limit; photos are compressed to ~150-300 KB WebP before storage
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 0, parts: 2 },
});

// multipart/form-data with a single "photo" field
export const receivePhoto = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.is('multipart/form-data')) { res.status(415).json({ error: 'Send the photo as multipart/form-data in a "photo" field' }); return; }
    upload.single('photo')(req, res, next);
};

// GET /venues/:venueId/photos  (owner, admin, any staff)
export const list = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ photos: await listPhotos(req.venueAccess!.venue.id) });
};

// POST /venues/:venueId/photos  (owner, admin)
export const create = async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'A "photo" file is required' }); return; }

    const photo = await addPhoto(req.venueAccess!.venue.id, file.buffer);
    res.status(201).json({ photo });
};

// PUT /venues/:venueId/photos/:photoId/cover  (owner, admin)
export const makeCover = async (req: Request, res: Response): Promise<void> => {
    const venueId = req.venueAccess!.venue.id;
    await setCover(venueId, uuidParam(req.params.photoId, 'photo id'));
    res.status(200).json({ photos: await listPhotos(venueId) });
};

export const orderSchema = z.strictObject({ photo_ids: z.array(z.uuid()).min(1).max(15) });

// PUT /venues/:venueId/photos/order  { photo_ids: [...] }  (owner, admin)
export const reorder = async (req: Request, res: Response): Promise<void> => {
    const venueId = req.venueAccess!.venue.id;
    const { photo_ids } = parse(orderSchema, req.body);
    await reorderPhotos(venueId, photo_ids);
    res.status(200).json({ photos: await listPhotos(venueId) });
};

// DELETE /venues/:venueId/photos/:photoId  (owner, admin)
export const remove = async (req: Request, res: Response): Promise<void> => {
    await deletePhoto(req.venueAccess!.venue.id, uuidParam(req.params.photoId, 'photo id'));
    res.status(204).end();
};
