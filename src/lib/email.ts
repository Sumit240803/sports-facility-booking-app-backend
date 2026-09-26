import { env } from '../config/env.js';

export const emailEnabled = (): boolean => Boolean(env.email.resendApiKey && env.email.from);

const escapeHtml = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class EmailError extends Error {
    constructor(message: string, public retryable: boolean) {
        super(message);
    }
}

// Sends through Resend. The idempotency key makes retries of the same delivery safe.
export const sendEmail = async (opts: { to: string; subject: string; text: string; link?: string; idempotencyKey: string }): Promise<void> => {
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">
<p>${escapeHtml(opts.text)}</p>
${opts.link ? `<p><a href="${escapeHtml(opts.link)}" style="display:inline-block;padding:10px 16px;background:#16a34a;color:#fff;border-radius:6px;text-decoration:none">Book now</a></p>` : ''}
<p style="color:#666;font-size:12px">You received this because you set a reminder on EasyPlay.</p></div>`;

    let res: globalThis.Response;
    try {
        res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${env.email.resendApiKey}`,
                'content-type': 'application/json',
                'idempotency-key': opts.idempotencyKey,
            },
            body: JSON.stringify({
                from: env.email.from,
                to: [opts.to],
                subject: opts.subject,
                text: opts.link ? `${opts.text}\n\n${opts.link}` : opts.text,
                html,
            }),
            signal: AbortSignal.timeout(10_000),
        });
    } catch (e) {
        throw new EmailError(`Network error: ${(e as Error).message}`, true);
    }
    if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        // 429 and 5xx are temporary; other 4xx (bad address, bad key) are not worth retrying
        throw new EmailError(`Resend ${res.status}: ${detail}`, res.status === 429 || res.status >= 500);
    }
};
