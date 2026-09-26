import { cert, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../config/env.js';

let app: App | null = null;

export const pushEnabled = (): boolean => Boolean(env.push.firebaseServiceAccount);

const messaging = () => {
    if (!app) {
        const json = JSON.parse(Buffer.from(env.push.firebaseServiceAccount!, 'base64').toString('utf8'));
        app = initializeApp({ credential: cert(json) }, 'easyplay');
    }
    return getMessaging(app);
};

// Errors meaning the token will never work again and should be removed
const DEAD_TOKEN_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument',
]);

export interface PushResult { sent: number; deadTokens: string[]; retryable: boolean; error?: string }

export const sendPush = async (tokens: string[], title: string, body: string, data: Record<string, unknown>): Promise<PushResult> => {
    // FCM data values must be strings
    const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    const res = await messaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: stringData,
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
    });

    const deadTokens: string[] = [];
    let retryable = false;
    let error: string | undefined;
    res.responses.forEach((r, i) => {
        if (r.success) return;
        const code = r.error?.code ?? '';
        if (DEAD_TOKEN_CODES.has(code)) deadTokens.push(tokens[i]!);
        else {
            retryable = true;
            error = `${code}: ${r.error?.message ?? ''}`;
        }
    });
    return { sent: res.successCount, deadTokens, retryable, ...(error ? { error } : {}) };
};
