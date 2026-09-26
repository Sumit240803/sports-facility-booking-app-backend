import sharp, { type Metadata } from 'sharp';
import { HttpError } from '../utils/http.js';

// Formats we accept as input (detected from file content, not the name/mimetype)
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);
// Reject decompression bombs: 50 megapixels covers any phone/DSLR photo
const MAX_INPUT_PIXELS = 50_000_000;
const MIN_DIMENSION = 400;

export const PHOTO_SIZES = {
    large: { max: 1600, quality: 80 },
    thumb: { max: 480, quality: 70 },
} as const;

export interface ProcessedPhoto {
    large: Buffer;
    thumb: Buffer;
    width: number;
    height: number;
}

const render = (input: Buffer, { max, quality }: { max: number; quality: number }) =>
    sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
        .rotate() // apply EXIF orientation before metadata is stripped
        .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 4 }) // output carries no EXIF/GPS metadata
        .toBuffer({ resolveWithObject: true });

// Validates, auto-rotates, resizes and re-encodes an uploaded photo to WebP
export const processPhoto = async (input: Buffer): Promise<ProcessedPhoto> => {
    let meta: Metadata;
    try {
        meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    } catch {
        throw new HttpError(415, 'File is not a supported image (use JPEG, PNG or WebP)');
    }
    if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
        throw new HttpError(415, 'Only JPEG, PNG, WebP and HEIF images are allowed');
    }
    if (!meta.width || !meta.height || meta.width * meta.height > MAX_INPUT_PIXELS) {
        throw new HttpError(413, 'Image resolution is too large');
    }
    if (Math.min(meta.width, meta.height) < MIN_DIMENSION) {
        throw new HttpError(400, `Image must be at least ${MIN_DIMENSION}px on its shorter side`);
    }

    try {
        const [large, thumb] = await Promise.all([render(input, PHOTO_SIZES.large), render(input, PHOTO_SIZES.thumb)]);
        return { large: large.data, thumb: thumb.data, width: large.info.width, height: large.info.height };
    } catch {
        // e.g. truncated/corrupt files, or HEIC variants libvips can't decode
        throw new HttpError(415, 'Could not read this image, please upload a JPEG, PNG or WebP');
    }
};

// Thumbnail key is derived from the main key: venues/<id>/<uuid>.webp -> venues/<id>/<uuid>-thumb.webp
export const thumbKey = (key: string): string => key.replace(/\.webp$/, '-thumb.webp');
