// OpenAPI 3.1 spec served at /api/docs. Keep in sync with routes: every new or changed
// endpoint must be documented here. Request bodies reuse the controllers' zod schemas.
import { z } from 'zod';
import * as catalog from '../controllers/catalog.controller.js';
import * as court from '../controllers/court.controller.js';
import * as me from '../controllers/me.controller.js';
import * as schedule from '../controllers/schedule.controller.js';
import * as photo from '../controllers/venuePhoto.controller.js';
import * as venue from '../controllers/venue.controller.js';
import { env } from '../config/env.js';

type Json = Record<string, unknown>;

const fromZod = (schema: z.ZodType): Json => {
    const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
    return json;
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Json, required: string[] = []): Json => ({ type: 'object', properties, required });
const json = (schema: Json) => ({ content: { 'application/json': { schema } } });
const body = (schema: Json) => ({ required: true, ...json(schema) });
const ok = (description: string, schema?: Json) => (schema ? { description, ...json(schema) } : { description });
const err = (description: string) => ({ description, ...json(ref('Error')) });

const auth = [{ bearerAuth: [] }];
const E = {
    400: err('Invalid input'),
    401: err('Missing or invalid access token'),
    403: err('Not allowed (role, venue access or suspended account)'),
    404: err('Not found'),
    409: err('Conflict / business rule violated'),
};
const pathParam = (name: string, description: string, format?: string) => ({
    name, in: 'path', required: true, description, schema: format ? { type: 'string', format } : { type: 'string' },
});
const query = (name: string, schema: Json, description?: string) => ({ name, in: 'query', required: false, schema, ...(description && { description }) });
const venueId = pathParam('venueId', 'Venue id', 'uuid');
const pageParams = [
    query('page', { type: 'integer', minimum: 1, maximum: 500, default: 1 }),
    query('limit', { type: 'integer', minimum: 1, maximum: 50, default: 20 }),
];

const op = (tag: string, summary: string, extra: Json = {}): Json => ({ tags: [tag], summary, ...extra });

const schemas: Record<string, Json> = {
    Error: obj({ error: { type: 'string' } }, ['error']),
    Profile: obj({
        id: { type: 'string', format: 'uuid' },
        email: { type: ['string', 'null'] },
        full_name: { type: ['string', 'null'] },
        avatar_url: { type: ['string', 'null'] },
        phone: { type: ['string', 'null'], example: '+919876543210' },
        phone_verified: { type: 'boolean' },
        city: { type: ['string', 'null'] },
        preferred_sports: { type: 'array', items: { type: 'string' } },
        role: { type: 'string', enum: ['player', 'venue_owner', 'admin'] },
        status: { type: 'string', enum: ['active', 'suspended'] },
        onboarded_at: { type: ['string', 'null'], format: 'date-time' },
        last_login_at: { type: ['string', 'null'], format: 'date-time' },
        notify_email: { type: 'boolean' },
        notify_push: { type: 'boolean' },
        created_at: { type: 'string', format: 'date-time' },
        updated_at: { type: 'string', format: 'date-time' },
    }),
    Session: obj({
        access_token: { type: 'string' },
        refresh_token: { type: 'string' },
        expires_at: { type: 'integer' },
        expires_in: { type: 'integer' },
        user: ref('Profile'),
    }),
    OwnerApplication: obj({
        user_id: { type: 'string', format: 'uuid' },
        business_name: { type: 'string' },
        business_phone: { type: 'string' },
        gstin: { type: ['string', 'null'] },
        verification_status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        rejection_reason: { type: ['string', 'null'] },
        reviewed_by: { type: ['string', 'null'], format: 'uuid' },
        reviewed_at: { type: ['string', 'null'], format: 'date-time' },
        created_at: { type: 'string', format: 'date-time' },
        updated_at: { type: 'string', format: 'date-time' },
    }),
    CatalogItem: obj({ id: { type: 'string' }, name: { type: 'string' }, is_active: { type: 'boolean' }, sort_order: { type: 'integer' } }),
    Photo: obj({
        id: { type: 'string', format: 'uuid' },
        url: { type: 'string', description: '1600px WebP' },
        thumb_url: { type: 'string', description: '480px WebP' },
        is_cover: { type: 'boolean' },
        sort_order: { type: 'integer' },
    }),
    Court: obj({
        id: { type: 'string', format: 'uuid' },
        venue_id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        sport_id: { type: 'string' },
        is_indoor: { type: 'boolean' },
        surface: { type: ['string', 'null'] },
        capacity: { type: ['integer', 'null'] },
        base_slot_minutes: { type: 'integer', enum: [30, 60] },
        min_duration_minutes: { type: 'integer' },
        max_duration_minutes: { type: 'integer' },
        price_per_hour_paise: { type: ['integer', 'null'], description: 'Base price per hour in paise (₹1 = 100)' },
        uses_venue_hours: { type: 'boolean', description: 'false when the court has its own opening hours' },
        is_active: { type: 'boolean' },
        sort_order: { type: 'integer' },
    }),
    Venue: obj({
        id: { type: 'string', format: 'uuid' },
        owner_id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        slug: { type: 'string' },
        description: { type: ['string', 'null'] },
        phone: { type: ['string', 'null'] },
        email: { type: ['string', 'null'] },
        address_line: { type: ['string', 'null'] },
        locality: { type: ['string', 'null'] },
        city: { type: ['string', 'null'] },
        state: { type: ['string', 'null'] },
        pincode: { type: ['string', 'null'] },
        lat: { type: ['number', 'null'] },
        lng: { type: ['number', 'null'] },
        amenities: { type: 'array', items: { type: 'string' } },
        rules: { type: ['string', 'null'] },
        timezone: { type: 'string', example: 'Asia/Kolkata' },
        booking_window_days: { type: 'integer', minimum: 1, maximum: 7, description: 'Bookings open this many days ahead (today counts as day 1)' },
        listing_window_days: { type: 'integer', minimum: 1, maximum: 30, description: 'Slots are visible this many days ahead' },
        min_notice_minutes: { type: 'integer', minimum: 0, maximum: 1440, description: 'No booking of slots starting sooner than this' },
        status: { type: 'string', enum: ['draft', 'pending_review', 'live', 'rejected', 'suspended'] },
        status_reason: { type: ['string', 'null'] },
        submitted_at: { type: ['string', 'null'], format: 'date-time' },
        reviewed_at: { type: ['string', 'null'], format: 'date-time' },
        created_at: { type: 'string', format: 'date-time' },
        updated_at: { type: 'string', format: 'date-time' },
    }),
    VenueSummary: obj({
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        slug: { type: 'string' },
        city: { type: ['string', 'null'] },
        locality: { type: ['string', 'null'] },
        status: { type: 'string' },
        status_reason: { type: ['string', 'null'] },
        cover_url: { type: ['string', 'null'] },
    }),
    VenueSearchResult: obj({
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        name: { type: 'string' },
        locality: { type: ['string', 'null'] },
        city: { type: 'string' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        amenities: { type: 'array', items: { type: 'string' } },
        sports: { type: 'array', items: { type: 'string' } },
        cover_url: { type: ['string', 'null'], description: 'Cover thumbnail' },
        distance_km: { type: ['number', 'null'] },
    }),
    PublicVenue: {
        allOf: [
            ref('Venue'),
            obj({
                sports: { type: 'array', items: { type: 'string' } },
                courts: { type: 'array', items: ref('Court') },
                photos: { type: 'array', items: ref('Photo') },
                hours: { type: 'array', items: ref('HoursRange') },
                court_hours: { type: 'object', additionalProperties: { type: 'array', items: ref('HoursRange') } },
            }),
        ],
        description: 'Public view: excludes owner_id, status and review fields',
    },
    HoursRange: obj({
        day: { type: 'integer', minimum: 0, maximum: 6, description: '0 = Sunday' },
        open: { type: 'string', example: '06:00' },
        close: { type: 'string', example: '02:00', description: 'close <= open means after midnight; open == close means 24 hours' },
        closes_next_day: { type: 'boolean' },
    }),
    Hours: obj({
        venue: { type: 'array', items: ref('HoursRange') },
        courts: { type: 'object', additionalProperties: { type: 'array', items: ref('HoursRange') }, description: 'Own hours of courts with uses_venue_hours = false, by court id' },
    }),
    PriceRule: obj({
        id: { type: 'string', format: 'uuid' },
        days: { type: ['array', 'null'], items: { type: 'integer' } },
        date: { type: ['string', 'null'], format: 'date' },
        start: { type: 'string', example: '18:00' },
        end: { type: 'string', example: '22:00' },
        price_per_hour_paise: { type: 'integer' },
    }),
    Pricing: obj({ price_per_hour_paise: { type: ['integer', 'null'] }, rules: { type: 'array', items: ref('PriceRule') } }),
    Block: obj({
        id: { type: 'string', format: 'uuid' },
        court_id: { type: ['string', 'null'], format: 'uuid', description: 'null = whole venue closed' },
        starts_at: { type: 'string', format: 'date-time' },
        ends_at: { type: 'string', format: 'date-time' },
        reason: { type: ['string', 'null'] },
        created_by: { type: ['string', 'null'], format: 'uuid' },
        created_at: { type: 'string', format: 'date-time' },
    }),
    Slot: obj({
        start: { type: 'string', format: 'date-time' },
        end: { type: 'string', format: 'date-time' },
        price_paise: { type: 'integer', description: 'Price of this one slot' },
        status: { type: 'string', enum: ['available', 'not_yet_open', 'closed', 'blocked', 'past'], description: 'closed = inside minimum notice; not_yet_open = listed, booking opens at opens_at' },
        opens_at: { type: 'string', format: 'date-time', description: 'Only for not_yet_open' },
    }),
    Availability: obj({
        date: { type: 'string', format: 'date' },
        timezone: { type: 'string' },
        today: { type: 'string', format: 'date' },
        booking_window_days: { type: 'integer' },
        listing_window_days: { type: 'integer' },
        bookable_until: { type: 'string', format: 'date' },
        listed_until: { type: 'string', format: 'date' },
        min_notice_minutes: { type: 'integer' },
        courts: {
            type: 'array',
            items: obj({
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                sport_id: { type: 'string' },
                is_indoor: { type: 'boolean' },
                base_slot_minutes: { type: 'integer' },
                min_duration_minutes: { type: 'integer' },
                max_duration_minutes: { type: 'integer' },
                slots: { type: 'array', items: ref('Slot') },
            }),
        },
    }),
    Reminder: obj({
        id: { type: 'string', format: 'uuid' },
        slot_start: { type: 'string', format: 'date-time' },
        slot_date: { type: 'string', format: 'date' },
        notify_at: { type: 'string', format: 'date-time' },
        status: { type: 'string', enum: ['pending', 'sent', 'cancelled'] },
    }),
    Notification: obj({
        id: { type: 'string', format: 'uuid' },
        type: { type: 'string', example: 'booking_open' },
        title: { type: 'string' },
        body: { type: 'string' },
        data: { type: 'object' },
        read_at: { type: ['string', 'null'], format: 'date-time' },
        created_at: { type: 'string', format: 'date-time' },
    }),
    StaffList: obj({
        members: { type: 'array', items: obj({ role: { type: 'string', enum: ['manager', 'staff'] }, created_at: { type: 'string' }, user: ref('Profile') }) },
        pending_invites: { type: 'array', items: obj({ email: { type: 'string' }, role: { type: 'string' }, created_at: { type: 'string' } }) },
    }),
};

const venueRes = ok('Venue', obj({ venue: ref('Venue') }));
const photosRes = ok('Photos in display order', obj({ photos: { type: 'array', items: ref('Photo') } }));
const paged = (item: string, key = 'venues') => obj({ [key]: { type: 'array', items: ref(item) }, page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' } });

const catalogPaths = (table: 'sports' | 'amenities', tag: string): Json => ({
    [`/${table}`]: { get: op(tag, `List active ${table}`, { responses: { 200: ok(table, obj({ [table]: { type: 'array', items: ref('CatalogItem') } })) } }) },
    [`/admin/${table}`]: {
        get: op('Admin', `List all ${table} incl. inactive`, { security: auth, responses: { 200: ok(table), 401: E[401], 403: E[403] } }),
        post: op('Admin', `Create ${table === 'sports' ? 'sport' : 'amenity'}`, {
            security: auth, requestBody: body(fromZod(catalog.createSchema)),
            responses: { 201: ok('Created', obj({ item: ref('CatalogItem') })), 400: E[400], 403: E[403], 409: E[409] },
        }),
    },
    [`/admin/${table}/{id}`]: {
        patch: op('Admin', `Update / deactivate ${table === 'sports' ? 'sport' : 'amenity'}`, {
            security: auth, parameters: [pathParam('id', 'Slug id')], requestBody: body(fromZod(catalog.updateSchema)),
            responses: { 200: ok('Updated', obj({ item: ref('CatalogItem') })), 400: E[400], 403: E[403], 404: E[404], 409: E[409] },
        }),
    },
});

const reviewAction = (action: string, summary: string, needsReason: boolean) => ({
    post: op('Admin', summary, {
        security: auth,
        parameters: [venueId],
        ...(needsReason ? { requestBody: body(fromZod(venue.reasonSchema)) } : {}),
        responses: { 200: venueRes, 403: E[403], 404: E[404], 409: err(`Venue is not in a state that allows ${action}${needsReason ? ', or reason missing' : ''}`) },
    }),
});

export const openApiSpec: Json = {
    openapi: '3.1.0',
    info: {
        title: 'EasyPlay API',
        version: '1.0.0',
        description: 'Sports facility booking platform. Authenticate with Google (`/auth/oauth/google`), then send `Authorization: Bearer <access_token>`.',
    },
    servers: [{ url: `${env.apiUrl}/api` }],
    tags: [
        { name: 'Auth' }, { name: 'Profile' }, { name: 'Owner applications' }, { name: 'Catalog' },
        { name: 'Venues (public)' }, { name: 'Venues (manage)' }, { name: 'Courts' }, { name: 'Photos' },
        { name: 'Hours & pricing' }, { name: 'Blocks' }, { name: 'Availability' },
        { name: 'Staff' }, { name: 'Me' }, { name: 'Admin' },
    ],
    components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        schemas,
    },
    paths: {
        // ---------------- Auth ----------------
        '/auth/oauth/{provider}': {
            get: op('Auth', 'Start OAuth sign-in', {
                description: 'Returns the provider URL and sets a short-lived httpOnly PKCE cookie. Open the URL in the same browser. `?redirect=true` redirects directly.',
                parameters: [pathParam('provider', 'Only `google`'), query('redirect', { type: 'boolean' })],
                responses: { 200: ok('Provider URL', obj({ provider_url: { type: 'string' } })), 302: { description: 'Redirect to provider (redirect=true)' }, 400: E[400] },
            }),
        },
        '/auth/oauth/callback': {
            get: op('Auth', 'OAuth callback (called by Supabase, not by clients)', {
                description: 'Exchanges the code and redirects to `FRONTEND_URL/auth/callback#access_token=..&refresh_token=..&expires_at=..` or `#error=..`.',
                parameters: [query('code', { type: 'string' })],
                responses: { 302: { description: 'Redirect to frontend' } },
            }),
        },
        '/auth/refresh': {
            post: op('Auth', 'Refresh session', {
                requestBody: body(obj({ refresh_token: { type: 'string' } }, ['refresh_token'])),
                responses: { 200: ok('New session', ref('Session')), 400: E[400], 401: E[401] },
            }),
        },
        '/auth/logout': {
            post: op('Auth', 'Log out', {
                security: auth,
                parameters: [query('scope', { type: 'string', enum: ['local', 'global'] }, '`global` logs out all devices')],
                responses: { 200: ok('Logged out'), 401: E[401] },
            }),
        },
        '/auth/me': {
            get: op('Profile', 'Current user profile', { security: auth, responses: { 200: ok('Profile', obj({ user: ref('Profile') })), 401: E[401], 403: E[403] } }),
            patch: op('Profile', 'Update own profile', {
                description: '`onboarded_at` is set automatically once full_name, phone and city are all present. Role/status cannot be changed here.',
                security: auth,
                requestBody: body(obj({
                    full_name: { type: ['string', 'null'] },
                    avatar_url: { type: ['string', 'null'] },
                    city: { type: ['string', 'null'] },
                    phone: { type: 'string', example: '+919876543210' },
                    preferred_sports: { type: 'array', items: { type: 'string' }, maxItems: 10 },
                    notify_email: { type: 'boolean' },
                    notify_push: { type: 'boolean' },
                })),
                responses: { 200: ok('Updated', obj({ user: ref('Profile') })), 400: E[400], 401: E[401], 409: err('Phone already used by another account') },
            }),
        },

        // ---------------- Owner applications ----------------
        '/owner-applications/me': {
            get: op('Owner applications', 'My venue-owner application', { security: auth, responses: { 200: ok('Application', obj({ application: ref('OwnerApplication') })), 404: E[404] } }),
            post: op('Owner applications', 'Apply (or re-apply after rejection) to become a venue owner', {
                description: 'Requires a completed profile. Rejected if an application is pending/approved or the user already has an elevated role.',
                security: auth,
                requestBody: body(obj({ business_name: { type: 'string' }, business_phone: { type: 'string' }, gstin: { type: 'string' } }, ['business_name', 'business_phone'])),
                responses: { 201: ok('Submitted', obj({ application: ref('OwnerApplication') })), 400: E[400], 409: E[409] },
            }),
        },
        '/admin/owner-applications': {
            get: op('Admin', 'List owner applications', {
                security: auth,
                parameters: [query('status', { type: 'string', enum: ['pending', 'approved', 'rejected'] })],
                responses: { 200: ok('Applications'), 403: E[403] },
            }),
        },
        '/admin/owner-applications/{userId}/approve': {
            post: op('Admin', 'Approve owner (role becomes venue_owner)', { security: auth, parameters: [pathParam('userId', 'Applicant id', 'uuid')], responses: { 200: ok('Approved'), 404: err('No pending application') } }),
        },
        '/admin/owner-applications/{userId}/reject': {
            post: op('Admin', 'Reject owner application', {
                security: auth, parameters: [pathParam('userId', 'Applicant id', 'uuid')],
                requestBody: body(obj({ reason: { type: 'string' } }, ['reason'])),
                responses: { 200: ok('Rejected'), 400: E[400], 404: err('No pending application') },
            }),
        },
        '/admin/users/{userId}': {
            patch: op('Admin', 'Change a user role and/or status', {
                security: auth, parameters: [pathParam('userId', 'User id', 'uuid')],
                requestBody: body(obj({ role: { type: 'string', enum: ['player', 'venue_owner', 'admin'] }, status: { type: 'string', enum: ['active', 'suspended'] } })),
                responses: { 200: ok('Updated', obj({ user: ref('Profile') })), 400: E[400], 404: E[404] },
            }),
        },

        // ---------------- Catalog ----------------
        ...catalogPaths('sports', 'Catalog'),
        ...catalogPaths('amenities', 'Catalog'),

        // ---------------- Venues ----------------
        '/venues': {
            get: op('Venues (public)', 'Search live venues', {
                parameters: [
                    query('city', { type: 'string' }, 'Case-insensitive exact city'),
                    query('sport', { type: 'string' }, 'Sport id, e.g. football'),
                    query('q', { type: 'string', maxLength: 60 }, 'Matches name or locality'),
                    query('amenities', { type: 'string' }, 'Comma-separated ids; venue must have all'),
                    query('lat', { type: 'number' }),
                    query('lng', { type: 'number' }),
                    query('radius_km', { type: 'number', minimum: 1, maximum: 100 }, 'Requires lat/lng'),
                    query('sort', { type: 'string', enum: ['name', 'distance', 'newest'] }, 'Defaults to distance when lat/lng given, else name'),
                    ...pageParams,
                ],
                responses: { 200: ok('Results', paged('VenueSearchResult')), 400: E[400] },
            }),
            post: op('Venues (manage)', 'Create venue (draft)', {
                description: 'venue_owner or admin. Max 50 venues per owner.',
                security: auth, requestBody: body(fromZod(venue.createSchema)),
                responses: { 201: venueRes, 400: E[400], 403: E[403], 409: E[409] },
            }),
        },
        '/venues/cities': {
            get: op('Venues (public)', 'Cities with live venues', { responses: { 200: ok('Cities', obj({ cities: { type: 'array', items: obj({ city: { type: 'string' }, venue_count: { type: 'integer' } }) } })) } }),
        },
        '/venues/mine': {
            get: op('Venues (manage)', 'Venues I own or work at', {
                security: auth,
                responses: { 200: ok('Venues', obj({ owned: { type: 'array', items: ref('VenueSummary') }, staff: { type: 'array', items: obj({ role: { type: 'string' }, venue: ref('VenueSummary') }) } })) },
            }),
        },
        '/venues/{idOrSlug}': {
            get: op('Venues (public)', 'Public venue page', {
                parameters: [pathParam('idOrSlug', 'Venue id or slug')],
                responses: { 200: ok('Venue', obj({ venue: ref('PublicVenue') })), 404: E[404] },
            }),
        },
        '/venues/{venueId}': {
            patch: op('Venues (manage)', 'Update venue incl. booking settings (owner, manager)', {
                description: 'Empty string or null clears optional fields. A listed venue cannot lose address, city, location or phone (409). listing_window_days must be >= booking_window_days. Changing booking_window_days reschedules pending reminders.',
                security: auth, parameters: [venueId], requestBody: body(fromZod(venue.updateSchema)),
                responses: { 200: venueRes, 400: E[400], 403: E[403], 404: E[404], 409: E[409] },
            }),
            delete: op('Venues (manage)', 'Delete venue (soft, owner only)', { security: auth, parameters: [venueId], responses: { 204: { description: 'Deleted' }, 403: E[403], 404: E[404] } }),
        },
        '/venues/{venueId}/manage': {
            get: op('Venues (manage)', 'Full venue incl. drafts, inactive courts (owner, admin, staff)', {
                security: auth, parameters: [venueId],
                responses: { 200: ok('Venue', obj({ venue: ref('Venue'), access: { type: 'string', enum: ['admin', 'owner', 'manager', 'staff'] } })), 403: E[403], 404: E[404] },
            }),
        },
        '/venues/{venueId}/submit': {
            post: op('Venues (manage)', 'Submit for admin review', {
                description: 'draft/rejected → pending_review. Requires address, city, location, phone, ≥1 photo, ≥1 active court, a price on every active court and venue opening hours.',
                security: auth, parameters: [venueId], responses: { 200: venueRes, 403: E[403], 404: E[404], 409: E[409] },
            }),
        },
        '/venues/{venueId}/unpublish': {
            post: op('Venues (manage)', 'Take venue off the public listing', {
                description: 'live/pending_review → draft. Not allowed for suspended venues.',
                security: auth, parameters: [venueId], responses: { 200: venueRes, 403: E[403], 404: E[404], 409: E[409] },
            }),
        },

        // ---------------- Courts ----------------
        '/venues/{venueId}/courts': {
            get: op('Courts', 'List courts incl. inactive (owner, admin, staff)', { security: auth, parameters: [venueId], responses: { 200: ok('Courts', obj({ courts: { type: 'array', items: ref('Court') } })), 403: E[403] } }),
            post: op('Courts', 'Create court (owner, manager)', {
                description: 'Durations must be multiples of base_slot_minutes (30 or 60); defaults 60/60/120. Max 50 courts per venue. On a listed venue an active court needs price_per_hour_paise.',
                security: auth, parameters: [venueId], requestBody: body(fromZod(court.createSchema)),
                responses: { 201: ok('Created', obj({ court: ref('Court') })), 400: E[400], 403: E[403], 409: err('Name taken or court limit reached') },
            }),
        },
        '/venues/{venueId}/courts/{courtId}': {
            patch: op('Courts', 'Update court (owner, manager)', {
                security: auth, parameters: [venueId, pathParam('courtId', 'Court id', 'uuid')], requestBody: body(fromZod(court.updateSchema)),
                responses: { 200: ok('Updated', obj({ court: ref('Court') })), 400: E[400], 404: E[404], 409: err('Name taken, or last active court of a listed venue') },
            }),
            delete: op('Courts', 'Delete court (soft, owner, manager)', {
                security: auth, parameters: [venueId, pathParam('courtId', 'Court id', 'uuid')],
                responses: { 204: { description: 'Deleted' }, 404: E[404], 409: err('Last active court of a listed venue') },
            }),
        },

        // ---------------- Photos ----------------
        '/venues/{venueId}/photos': {
            get: op('Photos', 'List photos (owner, admin, staff)', { security: auth, parameters: [venueId], responses: { 200: photosRes } }),
            post: op('Photos', 'Upload photo (owner, manager)', {
                description: 'JPEG/PNG/WebP (HEIF when decodable), up to 15 MB, min 400px short side. Stored as 1600px + 480px WebP with metadata stripped. Max 15 per venue; first photo becomes the cover.',
                security: auth, parameters: [venueId],
                requestBody: { required: true, content: { 'multipart/form-data': { schema: obj({ photo: { type: 'string', format: 'binary' } }, ['photo']) } } },
                responses: { 201: ok('Uploaded', obj({ photo: ref('Photo') })), 400: E[400], 409: err('Photo limit reached'), 413: err('File or resolution too large'), 415: err('Not a supported image') },
            }),
        },
        '/venues/{venueId}/photos/order': {
            put: op('Photos', 'Reorder photos (owner, manager)', {
                security: auth, parameters: [venueId], requestBody: body(fromZod(photo.orderSchema)),
                responses: { 200: photosRes, 400: E[400], 409: err('photo_ids must list every photo exactly once') },
            }),
        },
        '/venues/{venueId}/photos/{photoId}/cover': {
            put: op('Photos', 'Set cover photo (owner, manager)', { security: auth, parameters: [venueId, pathParam('photoId', 'Photo id', 'uuid')], responses: { 200: photosRes, 404: E[404] } }),
        },
        '/venues/{venueId}/photos/{photoId}': {
            delete: op('Photos', 'Delete photo (owner, manager)', {
                security: auth, parameters: [venueId, pathParam('photoId', 'Photo id', 'uuid')],
                responses: { 204: { description: 'Deleted; next photo becomes cover if needed' }, 404: E[404], 409: err('Last photo of a listed venue') },
            }),
        },

        // ---------------- Hours & pricing ----------------
        '/venues/{venueId}/hours': {
            get: op('Hours & pricing', 'Venue and court opening hours (any staff)', { security: auth, parameters: [venueId], responses: { 200: ok('Hours', ref('Hours')), 403: E[403] } }),
            put: op('Hours & pricing', 'Replace venue opening hours (owner, manager)', {
                description: 'Times in 30-minute steps. Several ranges per day allowed; overlaps (including across midnight and Sat→Sun) are rejected. A listed venue cannot clear its hours.',
                security: auth, parameters: [venueId], requestBody: body(fromZod(schedule.hoursSchema)),
                responses: { 200: ok('Hours', ref('Hours')), 400: E[400], 403: E[403], 409: E[409] },
            }),
        },
        '/venues/{venueId}/courts/{courtId}/hours': {
            put: op('Hours & pricing', 'Give a court its own opening hours (owner, manager)', {
                security: auth, parameters: [venueId, pathParam('courtId', 'Court id', 'uuid')], requestBody: body(fromZod(schedule.hoursSchema)),
                responses: { 200: ok('Hours', ref('Hours')), 400: E[400], 404: E[404], 409: E[409] },
            }),
            delete: op('Hours & pricing', 'Court follows venue hours again (owner, manager)', {
                security: auth, parameters: [venueId, pathParam('courtId', 'Court id', 'uuid')], responses: { 200: ok('Hours', ref('Hours')), 404: E[404] },
            }),
        },
        '/venues/{venueId}/courts/{courtId}/pricing': {
            get: op('Hours & pricing', 'Court base price and price rules (any staff)', {
                security: auth, parameters: [venueId, pathParam('courtId', 'Court id', 'uuid')], responses: { 200: ok('Pricing', ref('Pricing')), 404: E[404] },
            }),
            put: op('Hours & pricing', 'Replace court price rules (owner, manager)', {
                description: 'Each rule has either `days` (weekly, 0 = Sunday) or `date` (one day). Date rules beat weekly rules; unmatched times use the court base price (set via PATCH court). Rules cannot cross midnight (use 24:00 as end). Overlaps are rejected. Prices are per hour in paise.',
                security: auth, parameters: [venueId, pathParam('courtId', 'Court id', 'uuid')], requestBody: body(fromZod(schedule.pricingSchema)),
                responses: { 200: ok('Pricing', ref('Pricing')), 400: E[400], 404: E[404], 409: err('Rules overlap') },
            }),
        },

        // ---------------- Blocks ----------------
        '/venues/{venueId}/blocks': {
            get: op('Blocks', 'List blocks/closures (any staff)', {
                security: auth,
                parameters: [venueId, query('from', { type: 'string', format: 'date-time' }, 'Default now'), query('to', { type: 'string', format: 'date-time' }, 'Default from + 60 days')],
                responses: { 200: ok('Blocks', obj({ blocks: { type: 'array', items: ref('Block') } })), 400: E[400] },
            }),
            post: op('Blocks', 'Block a court or close the whole venue (any staff)', {
                description: 'Omit court_id to close the whole venue (e.g. a holiday). Max 62 days; must end in the future.',
                security: auth, parameters: [venueId], requestBody: body(fromZod(schedule.blockSchema)),
                responses: { 201: ok('Created', obj({ block: ref('Block') })), 400: E[400], 404: err('Court not found') },
            }),
        },
        '/venues/{venueId}/blocks/{blockId}': {
            delete: op('Blocks', 'Remove block (any staff)', { security: auth, parameters: [venueId, pathParam('blockId', 'Block id', 'uuid')], responses: { 204: { description: 'Removed' }, 404: E[404] } }),
        },

        // ---------------- Availability ----------------
        '/venues/{idOrSlug}/availability': {
            get: op('Availability', 'Slots for a live venue on one date', {
                description: 'Date must be within the listing window (default today). Slots beyond the booking window have status not_yet_open with opens_at, and can be saved as reminders.',
                parameters: [pathParam('idOrSlug', 'Venue id or slug'), query('date', { type: 'string', format: 'date' }), query('court_id', { type: 'string', format: 'uuid' })],
                responses: { 200: ok('Availability', ref('Availability')), 400: E[400], 404: E[404] },
            }),
        },
        '/venues/{venueId}/manage/availability': {
            get: op('Availability', 'Slots for any venue status, ±60 days (any staff)', {
                security: auth,
                parameters: [venueId, query('date', { type: 'string', format: 'date' }), query('court_id', { type: 'string', format: 'uuid' })],
                responses: { 200: ok('Availability', ref('Availability')), 400: E[400], 403: E[403] },
            }),
        },

        // ---------------- Me: reminders, notifications, devices ----------------
        '/me/reminders': {
            get: op('Me', 'My slot reminders', {
                security: auth, parameters: [query('status', { type: 'string', enum: ['pending', 'sent', 'cancelled'] })],
                responses: { 200: ok('Reminders', obj({ reminders: { type: 'array', items: ref('Reminder') } })) },
            }),
            post: op('Me', 'Remind me when booking opens for a slot', {
                description: 'Only for slots with status not_yet_open. `date` is the availability date the slot was listed under. Max 50 active reminders. You get an in-app notification (plus email/push if enabled) when booking opens.',
                security: auth, requestBody: body(fromZod(me.reminderSchema)),
                responses: { 201: ok('Created', obj({ reminder: ref('Reminder') })), 400: E[400], 404: err('Court or slot not found'), 409: err('Slot already bookable, duplicate, or limit reached') },
            }),
        },
        '/me/reminders/{id}': {
            delete: op('Me', 'Cancel a pending reminder', { security: auth, parameters: [pathParam('id', 'Reminder id', 'uuid')], responses: { 204: { description: 'Cancelled' }, 404: E[404] } }),
        },
        '/me/notifications': {
            get: op('Me', 'My notifications (newest first)', {
                security: auth, parameters: [query('unread', { type: 'string', enum: ['true', 'false'] }), ...pageParams],
                responses: { 200: ok('Notifications', obj({ notifications: { type: 'array', items: ref('Notification') }, total: { type: 'integer' }, unread_count: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } })) },
            }),
        },
        '/me/notifications/{id}/read': {
            post: op('Me', 'Mark notification read', { security: auth, parameters: [pathParam('id', 'Notification id', 'uuid')], responses: { 204: { description: 'Marked read' }, 404: E[404] } }),
        },
        '/me/notifications/read-all': {
            post: op('Me', 'Mark all notifications read', { security: auth, responses: { 200: ok('Count', obj({ updated: { type: 'integer' } })) } }),
        },
        '/me/push-tokens': {
            post: op('Me', 'Register this device for push (call on app start / token refresh)', { security: auth, requestBody: body(fromZod(me.pushTokenSchema)), responses: { 204: { description: 'Registered' }, 400: E[400] } }),
            delete: op('Me', 'Unregister this device (call on logout)', { security: auth, requestBody: body(fromZod(me.removePushTokenSchema)), responses: { 204: { description: 'Removed' }, 400: E[400] } }),
        },

        // ---------------- Staff ----------------
        '/venues/{venueId}/staff': {
            get: op('Staff', 'List staff and pending invites (owner, admin, manager)', { security: auth, parameters: [venueId], responses: { 200: ok('Staff', ref('StaffList')), 403: E[403] } }),
            post: op('Staff', 'Invite staff by email (owner/admin)', {
                description: 'Existing users are added immediately; otherwise an invite is stored and claimed on first sign-in.',
                security: auth, parameters: [venueId],
                requestBody: body(obj({ email: { type: 'string', format: 'email' }, role: { type: 'string', enum: ['manager', 'staff'], default: 'staff' } }, ['email'])),
                responses: { 201: ok('Added or invited', obj({ invited: { type: 'boolean' } })), 400: E[400], 403: E[403] },
            }),
        },
        '/venues/{venueId}/staff/{userId}': {
            patch: op('Staff', 'Change staff role (owner/admin)', {
                security: auth, parameters: [venueId, pathParam('userId', 'Staff user id', 'uuid')],
                requestBody: body(obj({ role: { type: 'string', enum: ['manager', 'staff'] } }, ['role'])),
                responses: { 200: ok('Updated'), 400: E[400], 404: E[404] },
            }),
            delete: op('Staff', 'Remove staff member (owner/admin)', { security: auth, parameters: [venueId, pathParam('userId', 'Staff user id', 'uuid')], responses: { 204: { description: 'Removed' }, 404: E[404] } }),
        },
        '/venues/{venueId}/staff/invites/{email}': {
            delete: op('Staff', 'Cancel pending invite (owner/admin)', { security: auth, parameters: [venueId, pathParam('email', 'Invited email')], responses: { 204: { description: 'Cancelled' }, 404: E[404] } }),
        },

        // ---------------- Admin: venues ----------------
        '/admin/venues': {
            get: op('Admin', 'List venues for review', {
                security: auth,
                parameters: [query('status', { type: 'string', enum: ['draft', 'pending_review', 'live', 'rejected', 'suspended'] }), query('city', { type: 'string' }), ...pageParams],
                responses: { 200: ok('Venues', paged('VenueSummary')), 403: E[403] },
            }),
        },
        '/admin/venues/{venueId}/approve': reviewAction('approve', 'Approve venue (pending_review → live)', false),
        '/admin/venues/{venueId}/reject': reviewAction('reject', 'Reject venue (pending_review → rejected)', true),
        '/admin/venues/{venueId}/suspend': reviewAction('suspend', 'Suspend venue (live/pending_review → suspended)', true),
        '/admin/venues/{venueId}/reinstate': reviewAction('reinstate', 'Reinstate suspended venue (→ live)', false),
    },
};
