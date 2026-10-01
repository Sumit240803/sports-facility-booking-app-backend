import 'dotenv/config';

const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env variable: ${name}`);
    return value;
};

export const env = {
    port: Number(process.env.PORT) || 3000,
    isProd: process.env.NODE_ENV === 'production',
    // Number of reverse proxies in front of the app (Render/Heroku-style hosts: 1) so req.ip is the client IP
    trustProxy: Number(process.env.TRUST_PROXY) || 0,
    supabaseUrl: required('SUPABASE_URL'),
    supabaseAnonKey: required('SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    // Public URL of this API, used to build the OAuth callback URL
    apiUrl: process.env.API_URL || `http://localhost:${Number(process.env.PORT) || 3000}`,
    // Frontend app URL, where users land after OAuth / magic link
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
    // Cloudflare R2 (S3-compatible) for venue photos
    r2: {
        accountId: required('R2_ACCOUNT_ID'),
        accessKeyId: required('R2_ACCESS_KEY_ID'),
        secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
        bucket: required('R2_BUCKET'),
        // Public base URL of the bucket (custom domain or https://pub-xxx.r2.dev), no trailing slash
        publicUrl: required('R2_PUBLIC_URL').replace(/\/+$/, ''),
    },
    // Optional channels: when unset, those deliveries are marked skipped (in-app still works)
    email: {
        resendApiKey: process.env.RESEND_API_KEY || null,
        from: process.env.EMAIL_FROM || null, // e.g. "EasyPlay <noreply@easyplay.in>"
    },
    push: {
        firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || null, // base64 of the service account JSON
    },
    // Background jobs (reminders, notification delivery). Safe to run on several instances.
    jobsEnabled: process.env.JOBS_ENABLED !== 'false',
    // Razorpay (optional until configured; online payment endpoints return 503 without it)
    razorpay: {
        keyId: process.env.RAZORPAY_KEY_ID || null,
        keySecret: process.env.RAZORPAY_KEY_SECRET || null,
        webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || null,
        apiBase: (process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1').replace(/\/+$/, ''),
    },
    payouts: {
        // Automatic Route payouts: minimum balance and how often per venue
        routeMinPaise: 10_000,
        routeEveryHours: 24,
    },
    booking: {
        // Platform-funded discount on online payments; venues are paid on the full price
        onlineDiscountPercent: 5,
        // How long an unpaid online booking holds its slot
        holdMinutes: 10,
    },
};
