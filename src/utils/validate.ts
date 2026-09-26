import { z } from 'zod';
import { HttpError } from './http.js';
import { PHONE_RE, UUID_RE, normalizePhone } from './validation.js';

// Parses input with a zod schema; throws a 400 with the first problem on failure
export const parse = <T extends z.ZodType>(schema: T, data: unknown): z.infer<T> => {
    const result = schema.safeParse(data ?? {});
    if (!result.success) {
        const issue = result.error.issues[0]!;
        const path = issue.path.join('.');
        throw new HttpError(400, path ? `${path}: ${issue.message}` : issue.message);
    }
    return result.data;
};

export const uuidParam = (value: unknown, name = 'id'): string => {
    if (typeof value !== 'string' || !UUID_RE.test(value)) throw new HttpError(400, `Invalid ${name}`);
    return value;
};

// Collapses inner whitespace and trims
export const cleanText = (min: number, max: number) =>
    z.string().transform((s) => s.replace(/\s+/g, ' ').trim()).pipe(z.string().min(min).max(max));

// Multi-line text: trims, keeps line breaks
export const longText = (max: number) => z.string().trim().max(max);

export const phoneSchema = z
    .string()
    .transform(normalizePhone)
    .refine((p) => PHONE_RE.test(p), 'must be in E.164 format, e.g. +919876543210');

export const slugId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lowercase letters, numbers and dashes').max(40);

export const pagination = {
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
};

// Escapes LIKE/ILIKE wildcards in user search input
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
