import type { Request } from 'express';

export class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

export const getBearerToken = (req: Request): string | null => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    return header.slice(7).trim() || null;
};

export const getCookie = (req: Request, name: string): string | null => {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return decodeURIComponent(rest.join('='));
    }
    return null;
};
