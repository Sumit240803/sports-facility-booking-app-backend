import { randomUUID } from 'node:crypto';
import { processPhoto, thumbKey } from '../lib/image.js';
import { deleteObject, putObject } from '../lib/r2.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { photoUrl, thumbUrl } from './venue.model.js';

export interface VenuePhoto {
    id: string;
    venue_id: string;
    storage_path: string;
    is_cover: boolean;
    sort_order: number;
    created_at: string;
}

const toPublic = ({ storage_path, ...photo }: VenuePhoto) => ({ ...photo, url: photoUrl(storage_path), thumb_url: thumbUrl(storage_path) });

export const listPhotos = async (venueId: string) => {
    const { data, error } = await supabaseAdmin.from('venue_photos').select('*').eq('venue_id', venueId).order('sort_order');
    if (error) throw error;
    return (data as VenuePhoto[]).map(toPublic);
};

const removeFiles = (key: string) =>
    Promise.all([deleteObject(key), deleteObject(thumbKey(key))]).catch((e) => console.error('Failed to remove photo files', key, e));

// Compresses the image, uploads large + thumbnail, then registers it.
// If any step fails (e.g. photo limit reached), uploaded files are removed again.
export const addPhoto = async (venueId: string, file: Buffer) => {
    const { large, thumb } = await processPhoto(file);
    const path = `venues/${venueId}/${randomUUID()}.webp`;
    try {
        await Promise.all([putObject(path, large, 'image/webp'), putObject(thumbKey(path), thumb, 'image/webp')]);
    } catch (err) {
        await removeFiles(path);
        throw err;
    }

    const { data, error } = await supabaseAdmin
        .from('venue_photos')
        .insert({ venue_id: venueId, storage_path: path })
        .select('*')
        .single();
    if (error) {
        await removeFiles(path);
        throw error;
    }
    return toPublic(data as VenuePhoto);
};

export const deletePhoto = async (venueId: string, photoId: string): Promise<void> => {
    const { data: path, error } = await supabaseAdmin.rpc('delete_venue_photo', { p_venue_id: venueId, p_photo_id: photoId });
    if (error) throw error;
    // The DB row is gone; a failed file removal only leaves an unreferenced file behind
    await removeFiles(path as string);
};

export const setCover = async (venueId: string, photoId: string): Promise<void> => {
    const { error } = await supabaseAdmin.rpc('set_venue_cover', { p_venue_id: venueId, p_photo_id: photoId });
    if (error) throw error;
};

export const reorderPhotos = async (venueId: string, photoIds: string[]): Promise<void> => {
    const { error } = await supabaseAdmin.rpc('reorder_venue_photos', { p_venue_id: venueId, p_photo_ids: photoIds });
    if (error) throw error;
};
