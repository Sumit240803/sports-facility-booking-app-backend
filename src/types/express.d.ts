import type { Profile } from '../models/user.model.js';
import type { Venue, VenueStaffRole } from '../models/venueStaff.model.js';

declare global {
    namespace Express {
        interface Request {
            user?: Profile;
            accessToken?: string;
            // Set by requireVenueAccess: the venue and how the user is allowed in
            venueAccess?: { venue: Venue; role: 'admin' | 'owner' | VenueStaffRole };
        }
    }
}

export {};
