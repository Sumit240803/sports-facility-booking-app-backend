// Seeds live test venues (courts, hours, prices, photos) owned by one user.
//
//   npm run seed:venues -- owner@example.com          create (skips venues that already exist)
//   npm run seed:venues -- owner@example.com --clean  soft-delete the seeded venues
//
// Uses the real models/RPCs, so every DB invariant still applies. Photos are generated
// with sharp and uploaded to R2 through addPhoto().
import sharp from 'sharp';
import { supabaseAdmin } from '../lib/supabase.js';
import { findProfileByEmail } from '../models/user.model.js';
import { createVenue, softDeleteVenue, transitionVenue } from '../models/venue.model.js';
import { createCourt } from '../models/court.model.js';
import { setHours, setPriceRules } from '../models/schedule.model.js';
import { addPhoto } from '../models/venuePhoto.model.js';

const SEED_TAG = '[seed]';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const h = (hours: number) => hours * 60;
const rupees = (r: number) => r * 100;

interface SeedCourt {
    name: string;
    sport_id: string;
    is_indoor: boolean;
    surface: string;
    capacity: number;
    base_slot_minutes: 30 | 60;
    min_duration_minutes: number;
    max_duration_minutes: number;
    price: number; // ₹ per hour
    peak?: number; // ₹ per hour, weekday evenings + weekends
}

interface SeedVenue {
    name: string;
    description: string;
    locality: string;
    address_line: string;
    pincode: string;
    lat: number;
    lng: number;
    phone: string;
    amenities: string[];
    rules: string;
    hours: { days: number[]; open: number; close: number }[];
    colors: [string, string];
    courts: SeedCourt[];
}

const VENUES: SeedVenue[] = [
    {
        name: 'Green Turf Arena',
        description: 'FIFA-grade artificial turf with floodlights for night games.',
        locality: 'Saket',
        address_line: 'Plot 12, Press Enclave Marg',
        pincode: '110017',
        lat: 28.5245,
        lng: 77.2066,
        phone: '+919810000001',
        amenities: ['parking', 'washroom', 'changing-room', 'drinking-water', 'floodlights'],
        rules: 'Studs allowed. No smoking on the turf.',
        hours: [{ days: ALL_DAYS, open: h(6), close: h(24) }],
        colors: ['#0B8A5B', '#0F5132'],
        courts: [
            { name: '5-a-side Turf A', sport_id: 'football', is_indoor: false, surface: 'Artificial turf', capacity: 10, base_slot_minutes: 60, min_duration_minutes: 60, max_duration_minutes: 180, price: 1200, peak: 1600 },
            { name: '5-a-side Turf B', sport_id: 'football', is_indoor: false, surface: 'Artificial turf', capacity: 10, base_slot_minutes: 60, min_duration_minutes: 60, max_duration_minutes: 180, price: 1000, peak: 1400 },
            { name: 'Box Cricket', sport_id: 'cricket', is_indoor: false, surface: 'Artificial turf', capacity: 16, base_slot_minutes: 60, min_duration_minutes: 60, max_duration_minutes: 240, price: 1500, peak: 2000 },
        ],
    },
    {
        name: 'Shuttle Point Badminton Club',
        description: 'Six wooden courts with BWF-approved mats and pro lighting.',
        locality: 'Dwarka Sector 10',
        address_line: 'Community Centre, Sector 10',
        pincode: '110075',
        lat: 28.5823,
        lng: 77.0500,
        phone: '+919810000002',
        amenities: ['parking', 'washroom', 'drinking-water', 'equipment-rental', 'locker', 'seating'],
        rules: 'Non-marking shoes only.',
        hours: [
            { days: ALL_DAYS, open: h(5), close: h(11) },
            { days: ALL_DAYS, open: h(16), close: h(23) },
        ],
        colors: ['#1565C0', '#0D2F5E'],
        courts: [1, 2, 3, 4].map((n) => ({
            name: `Court ${n}`, sport_id: 'badminton', is_indoor: true, surface: 'Wooden + synthetic mat', capacity: 4,
            base_slot_minutes: 30 as const, min_duration_minutes: 60, max_duration_minutes: 120, price: 500, peak: 700,
        })),
    },
    {
        name: 'Smash Pickleball & Tennis',
        description: 'Outdoor hard courts for pickleball and tennis. Paddles and rackets on rent.',
        locality: 'Vasant Kunj',
        address_line: 'Sector C, Pocket 8',
        pincode: '110070',
        lat: 28.5200,
        lng: 77.1580,
        phone: '+919810000003',
        amenities: ['parking', 'washroom', 'drinking-water', 'equipment-rental', 'floodlights', 'cafeteria'],
        rules: 'Tennis shoes required on hard courts.',
        hours: [{ days: ALL_DAYS, open: h(6), close: h(22) }],
        colors: ['#FF7A1A', '#9A3A00'],
        courts: [
            { name: 'Pickleball 1', sport_id: 'pickleball', is_indoor: false, surface: 'Acrylic hard court', capacity: 4, base_slot_minutes: 30, min_duration_minutes: 60, max_duration_minutes: 120, price: 600, peak: 800 },
            { name: 'Pickleball 2', sport_id: 'pickleball', is_indoor: false, surface: 'Acrylic hard court', capacity: 4, base_slot_minutes: 30, min_duration_minutes: 60, max_duration_minutes: 120, price: 600, peak: 800 },
            { name: 'Tennis Court', sport_id: 'tennis', is_indoor: false, surface: 'Hard court', capacity: 4, base_slot_minutes: 60, min_duration_minutes: 60, max_duration_minutes: 120, price: 900 },
        ],
    },
    {
        name: 'Rohini Sports Hub',
        description: 'Indoor multi-sport hall: basketball, table tennis and squash.',
        locality: 'Rohini Sector 9',
        address_line: 'Near Metro Pillar 350',
        pincode: '110085',
        lat: 28.7160,
        lng: 77.1120,
        phone: '+919810000004',
        amenities: ['washroom', 'changing-room', 'shower', 'drinking-water', 'wifi', 'first-aid'],
        rules: 'Closed on Mondays for maintenance.',
        hours: [{ days: [0, 2, 3, 4, 5, 6], open: h(7), close: h(22) }],
        colors: ['#6A1B9A', '#2E0A45'],
        courts: [
            { name: 'Basketball Full Court', sport_id: 'basketball', is_indoor: true, surface: 'Maple wood', capacity: 12, base_slot_minutes: 60, min_duration_minutes: 60, max_duration_minutes: 120, price: 1800, peak: 2200 },
            { name: 'TT Table 1', sport_id: 'table-tennis', is_indoor: true, surface: 'Rubber floor', capacity: 4, base_slot_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 120, price: 250 },
            { name: 'Squash Court', sport_id: 'squash', is_indoor: true, surface: 'Maple wood', capacity: 2, base_slot_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 90, price: 400 },
        ],
    },
];

const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const makePhoto = (title: string, subtitle: string, [from, to]: [string, string], variant: number): Promise<Buffer> => {
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
  </linearGradient></defs>
  <rect width="1600" height="1000" fill="url(#g)"/>
  <g stroke="#ffffff" stroke-opacity="0.35" stroke-width="10" fill="none">
    <rect x="160" y="180" width="1280" height="640" rx="8"/>
    <line x1="800" y1="180" x2="800" y2="820"/>
    <circle cx="800" cy="500" r="${90 + variant * 30}"/>
  </g>
  <text x="800" y="480" font-family="Arial, sans-serif" font-size="96" font-weight="700" fill="#fff" text-anchor="middle">${escapeXml(title)}</text>
  <text x="800" y="580" font-family="Arial, sans-serif" font-size="52" fill="#fff" fill-opacity="0.85" text-anchor="middle">${escapeXml(subtitle)}</text>
</svg>`;
    return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
};

const seedOne = async (ownerId: string, v: SeedVenue) => {
    const { data: existing } = await supabaseAdmin
        .from('venues').select('id').eq('owner_id', ownerId).eq('name', v.name).is('deleted_at', null).maybeSingle();
    if (existing) {
        console.log(`• ${v.name}: already exists, skipped`);
        return;
    }

    const venue = await createVenue(ownerId, {
        name: v.name,
        description: `${v.description} ${SEED_TAG}`,
        phone: v.phone,
        address_line: v.address_line,
        locality: v.locality,
        city: 'Delhi',
        state: 'Delhi',
        pincode: v.pincode,
        lat: v.lat,
        lng: v.lng,
        amenities: v.amenities,
        rules: v.rules,
        booking_window_days: 7,
        listing_window_days: 14,
        min_notice_minutes: 30,
        pay_at_venue_enabled: true,
        pay_at_venue_window_minutes: 720,
        cancellation_policy: [
            { hours_before: 24, refund_percent: 100 },
            { hours_before: 6, refund_percent: 50 },
        ],
    });

    await setHours(venue.id, null, v.hours.flatMap((r) => r.days.map((day) => ({ day, start: r.open, end: r.close }))));

    for (const [i, c] of v.courts.entries()) {
        const { price, peak, ...court } = c;
        const created = await createCourt(venue.id, { ...court, price_per_hour_paise: rupees(price), sort_order: i });
        if (peak) {
            await setPriceRules(venue.id, created.id, [
                { days: WEEKDAYS, date: null, start: h(17), end: h(22), price: rupees(peak) },
                { days: WEEKEND, date: null, start: h(7), end: h(22), price: rupees(peak) },
            ]);
        }
    }

    const sports = [...new Set(v.courts.map((c) => c.sport_id))].join(' · ');
    for (let i = 0; i < 3; i++) {
        await addPhoto(venue.id, await makePhoto(v.name, i === 0 ? v.locality : sports, v.colors, i));
    }

    await transitionVenue(venue.id, 'submit', ownerId);
    await transitionVenue(venue.id, 'approve', ownerId);
    console.log(`✓ ${v.name}: live with ${v.courts.length} courts (${venue.id})`);
};

const clean = async (ownerId: string) => {
    const { data, error } = await supabaseAdmin
        .from('venues').select('id, name').eq('owner_id', ownerId).like('description', `%${SEED_TAG}`).is('deleted_at', null);
    if (error) throw error;
    for (const v of data ?? []) {
        try {
            await softDeleteVenue(v.id);
            console.log(`✓ deleted ${v.name}`);
        } catch (e) {
            console.log(`✗ ${v.name}: ${(e as Error).message}`);
        }
    }
    if (!data?.length) console.log('No seeded venues found.');
};

const [email, flag] = process.argv.slice(2);
if (!email) {
    console.error('Usage: npm run seed:venues -- <owner-email> [--clean]');
    process.exit(1);
}
const owner = await findProfileByEmail(email);
if (!owner) {
    console.error(`No profile for ${email}. Sign in once with that account first.`);
    process.exit(1);
}

if (flag === '--clean') {
    await clean(owner.id);
} else {
    for (const v of VENUES) {
        try {
            await seedOne(owner.id, v);
        } catch (e) {
            console.log(`✗ ${v.name}: ${(e as { message?: string }).message ?? e}`);
        }
    }
}
