import 'dotenv/config';

const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env variable: ${name}`);
    return value;
};

export const env = {
    port: Number(process.env.PORT) || 3000,
    isProd: process.env.NODE_ENV === 'production',
    supabaseUrl: required('SUPABASE_URL'),
    supabaseAnonKey: required('SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    // Public URL of this API, used to build the OAuth callback URL
    apiUrl: process.env.API_URL || `http://localhost:${Number(process.env.PORT) || 3000}`,
    // Frontend app URL, where users land after OAuth / magic link
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
};
