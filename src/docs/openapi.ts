// OpenAPI 3.1 spec served at /api/docs. Keep in sync with routes: every new or changed
// endpoint must be documented here. Request bodies reuse the controllers' zod schemas.
import { z } from 'zod';
import * as booking from '../controllers/booking.controller.js';
import * as catalog from '../controllers/catalog.controller.js';
import * as court from '../controllers/court.controller.js';
import * as engagement from '../controllers/engagement.controller.js';
import * as me from '../controllers/me.controller.js';
import * as payment from '../controllers/payment.controller.js';
import * as payout from '../controllers/payout.controller.js';
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
        pay_at_venue_enabled: { type: 'boolean' },
        pay_at_venue_window_minutes: { type: 'integer', minimum: 15, maximum: 720, description: 'Pay at venue opens this many minutes before a slot' },
        cancellation_policy: {
            type: 'array',
            items: obj({ hours_before: { type: 'integer' }, refund_percent: { type: 'integer' } }),
            description: 'Refund tiers for player cancellations of paid bookings; first tier whose notice is met wins; otherwise 0%',
            example: [{ hours_before: 24, refund_percent: 100 }, { hours_before: 6, refund_percent: 50 }],
        },
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
        rating_avg: { type: ['number', 'null'], description: '1.0-5.0, null until the first review' },
        rating_count: { type: 'integer' },
    }),
    PublicVenue: {
        allOf: [
            ref('Venue'),
            obj({
                sports: { type: 'array', items: { type: 'string' } },
                courts: { type: 'array', items: ref('Court') },
                photos: { type: 'array', items: ref('Photo') },
                hours: { type: 'array', items: ref('HoursRange') },
                rating_avg: { type: ['number', 'null'] },
                rating_count: { type: 'integer' },
                is_favourite: { type: 'boolean', description: 'Only when called with a valid access token' },
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
        price_paise: { type: 'integer', description: 'Price of this one slot (pay at venue)' },
        online_price_paise: { type: 'integer', description: 'Indicative price with the online discount; the booking quote has the exact total' },
        pay_at_venue: { type: 'boolean', description: 'Pay at venue is possible for this slot right now' },
        status: { type: 'string', enum: ['available', 'booked', 'not_yet_open', 'closed', 'blocked', 'past'], description: 'closed = inside minimum notice; not_yet_open = listed, booking opens at opens_at' },
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
        online_discount_percent: { type: 'integer' },
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
    Booking: obj({
        id: { type: 'string', format: 'uuid' },
        reference: { type: 'string', example: 'EP-7K3M9Q', description: 'Show as QR / text for check-in' },
        venue_id: { type: 'string', format: 'uuid' },
        court_id: { type: 'string', format: 'uuid' },
        user_id: { type: ['string', 'null'], format: 'uuid' },
        customer_name: { type: ['string', 'null'], description: 'Walk-in bookings' },
        customer_phone: { type: ['string', 'null'] },
        starts_at: { type: 'string', format: 'date-time' },
        ends_at: { type: 'string', format: 'date-time' },
        slot_date: { type: 'string', format: 'date' },
        duration_minutes: { type: 'integer' },
        status: { type: 'string', enum: ['pending_payment', 'confirmed', 'checked_in', 'completed', 'cancelled', 'expired', 'no_show'] },
        payment_method: { type: 'string', enum: ['online', 'pay_at_venue', 'offline'] },
        payment_status: { type: 'string', enum: ['pending', 'paid', 'due', 'collected'] },
        subtotal_paise: { type: 'integer' },
        discount_percent: { type: 'integer' },
        discount_paise: { type: 'integer' },
        total_paise: { type: 'integer', description: 'Amount the player pays' },
        slots: { type: 'array', items: obj({ start: { type: 'string' }, end: { type: 'string' }, price_paise: { type: 'integer' } }) },
        cancellation_policy: { type: 'array', items: obj({ hours_before: { type: 'integer' }, refund_percent: { type: 'integer' } }), description: 'Snapshot at booking time' },
        expires_at: { type: ['string', 'null'], format: 'date-time', description: 'Online bookings: pay before this or the slot is released' },
        notes: { type: ['string', 'null'] },
        checked_in_at: { type: ['string', 'null'], format: 'date-time' },
        collected_paise: { type: ['integer', 'null'] },
        cancelled_at: { type: ['string', 'null'], format: 'date-time' },
        cancelled_by_role: { type: ['string', 'null'], enum: ['player', 'venue', 'admin', 'system', null] },
        cancel_reason: { type: ['string', 'null'] },
        refund_percent: { type: ['integer', 'null'] },
        refund_paise: { type: ['integer', 'null'] },
        refund_status: { type: 'string', enum: ['none', 'pending', 'processed', 'failed'] },
        created_at: { type: 'string', format: 'date-time' },
    }),
    PlayerBooking: {
        allOf: [
            ref('Booking'),
            obj({
                court: obj({ id: { type: 'string' }, name: { type: 'string' }, sport_id: { type: 'string' } }),
                venue: obj({ id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' }, address_line: { type: 'string' }, city: { type: 'string' }, phone: { type: 'string' }, timezone: { type: 'string' } }),
                cancellation: obj({ allowed: { type: 'boolean' }, refund_percent: { type: 'integer' }, refund_paise: { type: 'integer' } }, []),
            }),
        ],
    },
    VenueBooking: {
        allOf: [
            ref('Booking'),
            obj({
                court: obj({ id: { type: 'string' }, name: { type: 'string' }, sport_id: { type: 'string' } }),
                customer: { type: ['object', 'null'], properties: { id: { type: 'string' }, full_name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } } },
                events: { type: 'array', items: obj({ from_status: { type: ['string', 'null'] }, to_status: { type: 'string' }, actor_id: { type: ['string', 'null'] }, note: { type: ['string', 'null'] }, created_at: { type: 'string' } }), description: 'Detail endpoints only' },
            }),
        ],
    },
    Quote: obj({
        court_id: { type: 'string', format: 'uuid' },
        slot_date: { type: 'string', format: 'date' },
        starts_at: { type: 'string', format: 'date-time' },
        ends_at: { type: 'string', format: 'date-time' },
        duration_minutes: { type: 'integer' },
        payment_method: { type: 'string' },
        slots: { type: 'array', items: obj({ start: { type: 'string' }, end: { type: 'string' }, price_paise: { type: 'integer' } }) },
        subtotal_paise: { type: 'integer' },
        discount_percent: { type: 'integer' },
        discount_paise: { type: 'integer' },
        total_paise: { type: 'integer' },
        cancellation_policy: { type: 'array', items: { type: 'object' } },
    }),
    PaymentOrder: obj({
        key_id: { type: 'string', description: 'Razorpay key id for Checkout' },
        order_id: { type: 'string', example: 'order_Nxxxxxxxx' },
        amount_paise: { type: 'integer' },
        currency: { type: 'string', example: 'INR' },
        booking_id: { type: 'string', format: 'uuid' },
        reference: { type: 'string' },
        expires_at: { type: 'string', format: 'date-time' },
        checkout_timeout_seconds: { type: 'integer', description: 'Pass as Checkout `timeout`' },
        description: { type: 'string' },
        prefill: obj({ name: { type: ['string', 'null'] }, email: { type: ['string', 'null'] }, contact: { type: ['string', 'null'] } }),
    }),
    LedgerEntry: obj({
        id: { type: 'string', format: 'uuid' },
        entry_type: { type: 'string', enum: ['booking', 'payout', 'payout_reversal', 'adjustment'] },
        amount_paise: { type: 'integer', description: '+ credit to the venue, - debit' },
        description: { type: 'string' },
        booking_id: { type: ['string', 'null'] },
        payout_id: { type: ['string', 'null'] },
        created_at: { type: 'string', format: 'date-time' },
    }),
    Payout: obj({
        id: { type: 'string', format: 'uuid' },
        venue_id: { type: 'string', format: 'uuid' },
        amount_paise: { type: 'integer' },
        mode: { type: 'string', enum: ['manual', 'route'] },
        status: { type: 'string', enum: ['processing', 'paid', 'failed'] },
        razorpay_transfer_id: { type: ['string', 'null'] },
        reference: { type: ['string', 'null'], description: 'UTR / transaction reference for manual payouts' },
        failed_reason: { type: ['string', 'null'] },
        created_at: { type: 'string', format: 'date-time' },
        paid_at: { type: ['string', 'null'], format: 'date-time' },
    }),
    PayoutSettings: obj({
        venue_id: { type: 'string', format: 'uuid' },
        mode: { type: 'string', enum: ['manual', 'route'] },
        razorpay_account_id: { type: ['string', 'null'], description: 'Route linked account (set by admin)' },
        account_holder_name: { type: ['string', 'null'] },
        bank_account_number: { type: ['string', 'null'], description: 'Masked (••••1234) except for admins' },
        bank_ifsc: { type: ['string', 'null'] },
        upi_id: { type: ['string', 'null'] },
    }),
    Review: obj({
        id: { type: 'string', format: 'uuid' },
        venue_id: { type: 'string', format: 'uuid' },
        rating: { type: 'integer', minimum: 1, maximum: 5 },
        comment: { type: ['string', 'null'] },
        owner_reply: { type: ['string', 'null'] },
        owner_replied_at: { type: ['string', 'null'], format: 'date-time' },
        author: obj({ name: { type: 'string', description: 'First name only' }, avatar_url: { type: ['string', 'null'] } }),
        created_at: { type: 'string', format: 'date-time' },
        updated_at: { type: 'string', format: 'date-time' },
    }),
    RatingBreakdown: obj({ 1: { type: 'integer' }, 2: { type: 'integer' }, 3: { type: 'integer' }, 4: { type: 'integer' }, 5: { type: 'integer' } }),
    Favourite: obj({
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        slug: { type: 'string' },
        city: { type: ['string', 'null'] },
        locality: { type: ['string', 'null'] },
        rating_avg: { type: ['number', 'null'] },
        rating_count: { type: 'integer' },
        cover_url: { type: ['string', 'null'] },
        available: { type: 'boolean', description: 'false if the venue is currently unlisted, suspended or deleted' },
        saved_at: { type: 'string', format: 'date-time' },
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
        { name: 'Bookings' }, { name: 'Front desk' },
        { name: 'Payments' }, { name: 'Earnings' },
        { name: 'Reviews' }, { name: 'Favourites' }, { name: 'Dashboards' },
        { name: 'Staff' }, { name: 'Me' }, { name: 'Admin' }, { name: 'System' },
    ],
    components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        schemas,
    },
    paths: {
        '/health': {
            get: op('System', 'Liveness check', { responses: { 200: ok('Server is up', obj({ ok: { type: 'boolean' } })) } }),
        },

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
        '/auth/google/config': {
            get: op('Auth', 'Native Google Sign-In config (mobile)', {
                responses: { 200: ok('Web client id to request ID tokens for', obj({ web_client_id: { type: 'string' } })), 503: err('Google sign-in not configured') },
            }),
        },
        '/auth/google/token': {
            post: op('Auth', 'Sign in with a Google ID token (mobile)', {
                description: 'Send the ID token from native Google Sign-In (requested for the web client id). If the app passed a hashed nonce to Google, send the raw nonce here.',
                requestBody: body(obj({ id_token: { type: 'string' }, nonce: { type: 'string' } }, ['id_token'])),
                responses: { 200: ok('Session', ref('Session')), 400: E[400], 401: E[401], 403: E[403] },
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
        '/admin/users': {
            get: op('Admin', 'Search users', {
                security: auth,
                parameters: [
                    query('q', { type: 'string', maxLength: 80 }, 'Matches email, name or phone (case-insensitive)'),
                    query('role', { type: 'string', enum: ['player', 'venue_owner', 'admin'] }),
                    query('status', { type: 'string', enum: ['active', 'suspended'] }),
                    ...pageParams,
                ],
                responses: {
                    200: ok('Users, newest first', obj({ users: { type: 'array', items: ref('Profile') }, page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' } })),
                    400: E[400],
                },
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
                    query('sort', { type: 'string', enum: ['name', 'distance', 'newest', 'rating'] }, 'Defaults to distance when lat/lng given, else name'),
                    query('min_rating', { type: 'number', minimum: 1, maximum: 5 }),
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
                description: 'Send an access token (optional) to also get is_favourite.',
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
            delete: op('Venues (manage)', 'Delete venue (soft, owner only)', { security: auth, parameters: [venueId], responses: { 204: { description: 'Deleted' }, 403: E[403], 404: E[404], 409: err('Venue has upcoming bookings') } }),
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
                description: 'live/pending_review → draft. Not allowed for suspended venues or while there are upcoming bookings.',
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
                responses: { 200: ok('Updated', obj({ court: ref('Court') })), 400: E[400], 404: E[404], 409: err('Name taken, last active court of a listed venue, or deactivating / changing sport or slot length with upcoming bookings') },
            }),
            delete: op('Courts', 'Delete court (soft, owner, manager)', {
                security: auth, parameters: [venueId, pathParam('courtId', 'Court id', 'uuid')],
                responses: { 204: { description: 'Deleted' }, 404: E[404], 409: err('Last active court of a listed venue, or upcoming bookings') },
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
                description: 'Omit court_id to close the whole venue (e.g. a holiday). Max 62 days; must end in the future. Cannot overlap active bookings (cancel them first).',
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

        // ---------------- Bookings (player) ----------------
        '/bookings/quote': {
            post: op('Bookings', 'Price and validate a booking without creating it', {
                security: auth, requestBody: body(fromZod(booking.playerBookingSchema)),
                responses: { 200: ok('Quote', obj({ quote: ref('Quote') })), 400: E[400], 404: err('Court or slot not found'), 409: err('Slot not bookable (booked, blocked, not open yet, pay-at-venue rules, …)'), 429: err('Too many attempts') },
            }),
        },
        '/bookings': {
            post: op('Bookings', 'Book a court', {
                description: [
                    '`date` is the availability date the slot is listed under; `start` must be a slot start; duration a multiple of the court slot length within its min/max.',
                    '**online**: 5% off (platform-funded); status `pending_payment`, holds the slot until `expires_at` (10 min). Then call `POST /me/bookings/{id}/pay` and open Razorpay Checkout.',
                    '**pay_at_venue**: confirmed immediately; only when the venue allows it, within its pay-at-venue window before the slot, and only one upcoming pay-at-venue booking per player.',
                    'Send an `Idempotency-Key` header (8-100 chars) so retries never double book; a repeat returns the same booking. Requires a completed profile. 20 attempts/min per user.',
                ].join('\n\n'),
                security: auth,
                parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }],
                requestBody: body(fromZod(booking.playerBookingSchema)),
                responses: { 201: ok('Booked', obj({ booking: ref('Booking') })), 400: E[400], 404: E[404], 409: err('Slot already booked or not bookable'), 429: err('Too many attempts') },
            }),
        },
        '/me/bookings': {
            get: op('Bookings', 'My bookings', {
                security: auth, parameters: [query('scope', { type: 'string', enum: ['upcoming', 'past'], default: 'upcoming' }), ...pageParams],
                responses: { 200: ok('Bookings', obj({ bookings: { type: 'array', items: ref('PlayerBooking') }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } })) },
            }),
        },
        '/me/bookings/{id}': {
            get: op('Bookings', 'My booking, with what a cancellation would refund now', {
                security: auth, parameters: [pathParam('id', 'Booking id', 'uuid')], responses: { 200: ok('Booking', obj({ booking: ref('PlayerBooking') })), 404: E[404] },
            }),
        },
        '/me/bookings/{id}/cancel': {
            post: op('Bookings', 'Cancel my booking', {
                description: 'Before the start only. Paid bookings are refunded per the policy snapshot on the booking.',
                security: auth, parameters: [pathParam('id', 'Booking id', 'uuid')],
                requestBody: { required: false, ...json(obj({ reason: { type: 'string' } })) },
                responses: { 200: ok('Cancelled', obj({ booking: ref('Booking') })), 404: E[404], 409: E[409] },
            }),
        },

        // ---------------- Payments ----------------
        '/me/bookings/{id}/pay': {
            post: op('Payments', 'Start paying a pending online booking (Razorpay order)', {
                description: 'Returns what Razorpay Checkout needs. Calling again reuses the same order. Fails once the 10-minute payment window has ended.',
                security: auth, parameters: [pathParam('id', 'Booking id', 'uuid')],
                responses: { 200: ok('Order', ref('PaymentOrder')), 404: E[404], 409: err('Not waiting for payment / window ended'), 503: err('Payments not configured') },
            }),
        },
        '/me/bookings/{id}/pay/verify': {
            post: op('Payments', 'Confirm payment after Checkout succeeds', {
                description: 'Send the three values from the Checkout success handler. The signature is verified and the payment re-read from Razorpay. outcome: confirmed | already_processed | refund_queued (payment could not be used and is refunded automatically) | failed. The webhook confirms the booking too, so the app may also just poll the booking.',
                security: auth, parameters: [pathParam('id', 'Booking id', 'uuid')], requestBody: body(fromZod(payment.verifySchema)),
                responses: {
                    200: ok('Result', obj({ outcome: { type: 'string' }, refund_reason: { type: 'string' }, booking: ref('PlayerBooking') })),
                    400: err('Invalid signature'), 404: E[404], 503: err('Payments not configured'),
                },
            }),
        },
        '/payments/webhook': {
            post: op('Payments', 'Razorpay webhook (called by Razorpay only)', {
                description: 'Verified with X-Razorpay-Signature (HMAC-SHA256 of the raw body with the webhook secret) and de-duplicated by X-Razorpay-Event-Id. Handles payment.authorized/captured/failed, order.paid, refund.processed/failed, transfer.processed/failed.',
                responses: { 200: ok('Processed'), 400: err('Invalid signature') },
            }),
        },

        // ---------------- Earnings (owner) ----------------
        '/venues/{venueId}/earnings': {
            get: op('Earnings', 'Balance, ledger and recent payouts (owner)', {
                description: 'Online bookings credit subtotal minus 10% commission when completed / no-show (partially for player cancellations that kept money). Completed pay-at-venue bookings debit the 10% commission. Walk-ins have no commission.',
                security: auth, parameters: [venueId, ...pageParams],
                responses: {
                    200: ok('Earnings', obj({
                        balance_paise: { type: 'integer' }, commission_percent: { type: 'integer' }, payout_mode: { type: 'string' },
                        ledger: { type: 'array', items: ref('LedgerEntry') }, ledger_total: { type: 'integer' },
                        recent_payouts: { type: 'array', items: ref('Payout') },
                    })),
                    403: E[403],
                },
            }),
        },
        '/venues/{venueId}/payout-settings': {
            get: op('Earnings', 'Payout settings (owner; bank account masked)', { security: auth, parameters: [venueId], responses: { 200: ok('Settings', obj({ settings: ref('PayoutSettings') })), 403: E[403] } }),
            put: op('Earnings', 'Update payout settings (owner)', {
                description: 'manual: needs full bank details (holder, account number, IFSC) or a UPI id. route: automatic daily transfers, only after EasyPlay has set up the Razorpay linked account.',
                security: auth, parameters: [venueId], requestBody: body(fromZod(payout.settingsSchema)),
                responses: { 200: ok('Settings', obj({ settings: ref('PayoutSettings') })), 400: E[400], 403: E[403], 409: err('Route not set up yet') },
            }),
        },

        // ---------------- Admin: money ----------------
        '/admin/payouts/balances': {
            get: op('Admin', 'Venues with a non-zero balance', { security: auth, responses: { 200: ok('Balances', obj({ venues: { type: 'array', items: obj({ venue_id: { type: 'string' }, venue_name: { type: 'string' }, venue_slug: { type: 'string' }, city: { type: ['string', 'null'] }, payout_mode: { type: 'string' }, balance_paise: { type: 'integer' } }) } })) } }),
        },
        '/admin/payouts': {
            get: op('Admin', 'List payouts', {
                security: auth, parameters: [query('status', { type: 'string', enum: ['processing', 'paid', 'failed'] }), query('venue_id', { type: 'string', format: 'uuid' }), ...pageParams],
                responses: { 200: ok('Payouts', paged('Payout', 'payouts')) },
            }),
        },
        '/admin/payouts/{payoutId}/resolve': {
            post: op('Admin', 'Settle a payout stuck in processing', {
                description: 'Use after checking the transfer in the Razorpay dashboard. failed puts the amount back on the venue balance.',
                security: auth, parameters: [pathParam('payoutId', 'Payout id', 'uuid')], requestBody: body(fromZod(payout.resolveSchema)),
                responses: { 200: ok('Payout', obj({ payout: ref('Payout') })), 400: E[400], 404: E[404], 409: err('Not processing') },
            }),
        },
        '/admin/venues/{venueId}/payout-settings': {
            get: op('Admin', 'Full payout settings and balance of a venue', { security: auth, parameters: [venueId], responses: { 200: ok('Settings', obj({ settings: ref('PayoutSettings'), balance_paise: { type: 'integer' } })) } }),
            put: op('Admin', 'Set the Razorpay Route linked account', {
                description: 'null removes it (and switches a route venue back to manual).',
                security: auth, parameters: [venueId], requestBody: body(fromZod(payout.linkedAccountSchema)),
                responses: { 200: ok('Settings', obj({ settings: ref('PayoutSettings') })), 400: E[400] },
            }),
        },
        '/admin/venues/{venueId}/payouts': {
            post: op('Admin', 'Record a manual payout (after sending the bank/UPI transfer)', {
                security: auth, parameters: [venueId], requestBody: body(fromZod(payout.manualPayoutSchema)),
                responses: { 201: ok('Recorded', obj({ payout: ref('Payout'), balance_paise: { type: 'integer' } })), 400: E[400], 409: err('More than the balance') },
            }),
        },
        '/admin/venues/{venueId}/adjustments': {
            post: op('Admin', 'Ledger adjustment (+ credit / - debit, e.g. commission paid by the venue in cash)', {
                security: auth, parameters: [venueId], requestBody: body(fromZod(payout.adjustmentSchema)),
                responses: { 201: ok('Added', obj({ entry: ref('LedgerEntry'), balance_paise: { type: 'integer' } })), 400: E[400] },
            }),
        },
        '/admin/refunds': {
            get: op('Admin', 'List refunds', {
                security: auth, parameters: [query('status', { type: 'string', enum: ['pending', 'processing', 'processed', 'failed'] }), ...pageParams],
                responses: { 200: ok('Refunds') },
            }),
        },
        '/admin/refunds/{refundId}/retry': {
            post: op('Admin', 'Retry a failed refund', { security: auth, parameters: [pathParam('refundId', 'Refund id', 'uuid')], responses: { 204: { description: 'Queued' }, 409: err('Not failed') } }),
        },

        // ---------------- Reviews ----------------
        '/venues/{idOrSlug}/reviews': {
            get: op('Reviews', 'Visible reviews of a live venue', {
                parameters: [pathParam('idOrSlug', 'Venue id or slug'), query('sort', { type: 'string', enum: ['newest', 'highest', 'lowest'], default: 'newest' }), ...pageParams],
                responses: { 200: ok('Reviews', obj({ reviews: { type: 'array', items: ref('Review') }, breakdown: ref('RatingBreakdown'), total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } })), 404: E[404] },
            }),
        },
        '/me/reviews': {
            get: op('Reviews', 'My reviews', { security: auth, responses: { 200: ok('Reviews') } }),
        },
        '/me/reviews/{venueId}': {
            put: op('Reviews', 'Write or update my review of a venue', {
                description: 'One review per player per venue; allowed once the player has played there (a completed booking). Updating keeps a single review.',
                security: auth, parameters: [pathParam('venueId', 'Venue id', 'uuid')], requestBody: body(fromZod(engagement.reviewSchema)),
                responses: { 200: ok('Saved', obj({ review: ref('Review') })), 400: E[400], 404: E[404], 409: err('Not played there yet') },
            }),
            delete: op('Reviews', 'Delete my review', { security: auth, parameters: [pathParam('venueId', 'Venue id', 'uuid')], responses: { 204: { description: 'Deleted' }, 404: E[404] } }),
        },
        '/venues/{venueId}/manage/reviews': {
            get: op('Reviews', 'All reviews incl. hidden (any staff)', {
                security: auth, parameters: [venueId, query('sort', { type: 'string', enum: ['newest', 'highest', 'lowest'] }), ...pageParams],
                responses: { 200: ok('Reviews'), 403: E[403] },
            }),
        },
        '/venues/{venueId}/reviews/{reviewId}/reply': {
            put: op('Reviews', 'Reply to a review (owner, manager); the player is notified', {
                security: auth, parameters: [venueId, pathParam('reviewId', 'Review id', 'uuid')], requestBody: body(fromZod(engagement.replySchema)),
                responses: { 200: ok('Replied', obj({ review: ref('Review') })), 400: E[400], 403: E[403], 404: E[404] },
            }),
            delete: op('Reviews', 'Remove the reply (owner, manager)', { security: auth, parameters: [venueId, pathParam('reviewId', 'Review id', 'uuid')], responses: { 200: ok('Removed'), 404: E[404] } }),
        },
        '/admin/reviews': {
            get: op('Admin', 'List reviews for moderation', { security: auth, parameters: [query('status', { type: 'string', enum: ['visible', 'hidden'] }), ...pageParams], responses: { 200: ok('Reviews') } }),
        },
        '/admin/reviews/{reviewId}/hide': {
            post: op('Admin', 'Hide a review (removed from ratings)', {
                security: auth, parameters: [pathParam('reviewId', 'Review id', 'uuid')], requestBody: body(fromZod(engagement.hideSchema)),
                responses: { 200: ok('Hidden'), 400: E[400], 404: E[404] },
            }),
        },
        '/admin/reviews/{reviewId}/unhide': {
            post: op('Admin', 'Make a hidden review visible again', { security: auth, parameters: [pathParam('reviewId', 'Review id', 'uuid')], responses: { 200: ok('Visible'), 404: E[404] } }),
        },

        // ---------------- Favourites ----------------
        '/me/favourites': {
            get: op('Favourites', 'My favourite venues', { security: auth, responses: { 200: ok('Favourites', obj({ favourites: { type: 'array', items: ref('Favourite') } })) } }),
        },
        '/me/favourites/{venueId}': {
            put: op('Favourites', 'Save a live venue (idempotent, max 200)', { security: auth, parameters: [pathParam('venueId', 'Venue id', 'uuid')], responses: { 204: { description: 'Saved' }, 404: E[404], 409: err('Limit reached') } }),
            delete: op('Favourites', 'Remove from favourites', { security: auth, parameters: [pathParam('venueId', 'Venue id', 'uuid')], responses: { 204: { description: 'Removed' }, 404: E[404] } }),
        },

        // ---------------- Dashboards ----------------
        '/venues/{venueId}/dashboard': {
            get: op('Dashboards', 'Owner dashboard (owner, admin)', {
                description: 'Venue-local dates, default last 30 days, max 366. Bookings by status/method, cancellation & no-show rates, money (booked value, online received, collected at venue, refunds, venue earnings, commission, current balance), per-court occupancy (booked vs open minutes), daily series, peak hours (day of week × hour), ratings, today\'s upcoming bookings.',
                security: auth, parameters: [venueId, query('from', { type: 'string', format: 'date' }), query('to', { type: 'string', format: 'date' })],
                responses: { 200: ok('Dashboard', obj({ dashboard: { type: 'object' } })), 400: E[400], 403: E[403] },
            }),
        },
        '/admin/dashboard': {
            get: op('Admin', 'Platform dashboard', {
                description: 'Asia/Kolkata dates, default last 30 days, max 366. Booking counts, gross booking value, online captured, refunds, discounts given, platform revenue before fees, Razorpay fees (2% + 18% GST), platform net, amount owed to venues, venue/user counts, items needing attention, top 10 venues.',
                security: auth, parameters: [query('from', { type: 'string', format: 'date' }), query('to', { type: 'string', format: 'date' })],
                responses: { 200: ok('Dashboard', obj({ dashboard: { type: 'object' } })), 400: E[400], 403: E[403] },
            }),
        },

        // ---------------- Front desk (venue staff) ----------------
        '/venues/{venueId}/bookings': {
            get: op('Front desk', 'Bookings for a local day or a time range (any staff)', {
                security: auth,
                parameters: [
                    venueId,
                    query('date', { type: 'string', format: 'date' }, 'Venue-local day (default today)'),
                    query('from', { type: 'string', format: 'date-time' }),
                    query('to', { type: 'string', format: 'date-time' }, 'Max 31 days after from'),
                    query('status', { type: 'string' }, 'Comma-separated statuses'),
                ],
                responses: { 200: ok('Bookings', obj({ from: { type: 'string' }, to: { type: 'string' }, bookings: { type: 'array', items: ref('VenueBooking') } })), 400: E[400], 403: E[403] },
            }),
            post: op('Front desk', 'Walk-in / phone booking (any staff)', {
                description: 'Confirmed immediately, paid at the venue. Can book a slot that is already running, inside the minimum notice, or beyond the booking window (within the listing window). Never overlaps other bookings or blocks.',
                security: auth, parameters: [venueId], requestBody: body(fromZod(booking.offlineBookingSchema)),
                responses: { 201: ok('Booked', obj({ booking: ref('Booking') })), 400: E[400], 404: E[404], 409: E[409] },
            }),
        },
        '/venues/{venueId}/bookings/by-reference/{reference}': {
            get: op('Front desk', 'Find a booking by reference / QR (any staff)', {
                security: auth, parameters: [venueId, pathParam('reference', 'e.g. EP-7K3M9Q (case-insensitive)')], responses: { 200: ok('Booking', obj({ booking: ref('VenueBooking') })), 404: E[404] },
            }),
        },
        '/venues/{venueId}/bookings/{bookingId}': {
            get: op('Front desk', 'Booking detail with status history (any staff)', {
                security: auth, parameters: [venueId, pathParam('bookingId', 'Booking id', 'uuid')], responses: { 200: ok('Booking', obj({ booking: ref('VenueBooking') })), 404: E[404] },
            }),
        },
        '/venues/{venueId}/bookings/{bookingId}/check-in': {
            post: op('Front desk', 'Check in (any staff)', {
                description: 'From 30 min before start until the end. Optionally record the amount collected for pay-at-venue / walk-in bookings.',
                security: auth, parameters: [venueId, pathParam('bookingId', 'Booking id', 'uuid')],
                requestBody: { required: false, ...json(obj({ collected_paise: { type: 'integer' } })) },
                responses: { 200: ok('Checked in', obj({ booking: ref('Booking') })), 404: E[404], 409: E[409] },
            }),
        },
        '/venues/{venueId}/bookings/{bookingId}/collect': {
            post: op('Front desk', 'Record payment collected at the venue (any staff)', {
                security: auth, parameters: [venueId, pathParam('bookingId', 'Booking id', 'uuid')],
                requestBody: body(obj({ amount_paise: { type: 'integer' } }, ['amount_paise'])),
                responses: { 200: ok('Collected', obj({ booking: ref('Booking') })), 404: E[404], 409: E[409] },
            }),
        },
        '/venues/{venueId}/bookings/{bookingId}/no-show': {
            post: op('Front desk', 'Mark no-show (any staff)', {
                description: 'After the start and up to 24h after the end, only if never checked in. Paid time is never released.',
                security: auth, parameters: [venueId, pathParam('bookingId', 'Booking id', 'uuid')], responses: { 200: ok('Marked', obj({ booking: ref('Booking') })), 404: E[404], 409: E[409] },
            }),
        },
        '/venues/{venueId}/bookings/{bookingId}/undo-no-show': {
            post: op('Front desk', 'Undo no-show (any staff)', {
                description: 'Within 24h after the end. Becomes checked_in (or completed if already over).',
                security: auth, parameters: [venueId, pathParam('bookingId', 'Booking id', 'uuid')], responses: { 200: ok('Undone', obj({ booking: ref('Booking') })), 404: E[404], 409: E[409] },
            }),
        },
        '/venues/{venueId}/bookings/{bookingId}/cancel': {
            post: op('Front desk', 'Cancel a booking as the venue (owner, manager)', {
                description: 'Before the booking ends; always a full refund of anything paid; the player is notified.',
                security: auth, parameters: [venueId, pathParam('bookingId', 'Booking id', 'uuid')],
                requestBody: body(obj({ reason: { type: 'string' } }, ['reason'])),
                responses: { 200: ok('Cancelled', obj({ booking: ref('Booking') })), 400: E[400], 403: E[403], 404: E[404], 409: E[409] },
            }),
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
        '/admin/venues/{venueId}/suspend': reviewAction('suspend', 'Suspend venue (live/pending_review → suspended); cancels upcoming bookings with full refunds and notifies players', true),
        '/admin/venues/{venueId}/reinstate': reviewAction('reinstate', 'Reinstate suspended venue (→ live)', false),
    },
};
