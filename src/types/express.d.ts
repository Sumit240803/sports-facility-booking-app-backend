import type { Profile } from '../models/user.model.js';

declare global {
    namespace Express {
        interface Request {
            user?: Profile;
            accessToken?: string;
        }
    }
}

export {};
