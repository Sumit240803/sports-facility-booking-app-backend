export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_RE = /^\+[1-9]\d{7,14}$/; // E.164, e.g. +919876543210
export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PHONE_ERROR = 'Phone must be in E.164 format, e.g. +919876543210';

export const normalizePhone = (value: string): string => value.replace(/[\s-]/g, '');

// Trimmed non-empty string, or undefined
export const readString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
