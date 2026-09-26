# EasyPlay Backend

Sports facility booking platform: players browse venues (turfs, courts, grounds), view availability and book slots.
Venue owners list venues; venue staff manage day-to-day bookings; admins approve owners/venues.

## Engineering standards (non-negotiable)
- **Reliable, fast and secure.** Every feature is built completely when it is built: no TODOs, no "later" stubs.
- **Consider every edge case and bug** for each module: invalid/missing input, auth and role checks,
  ownership checks, concurrency/race conditions, duplicates, time zones, pagination limits, deleted/suspended
  entities, partial failures. Enforce critical invariants in the database (constraints, transactions), not only in code.
- **Keep Swagger in sync:** every new/changed endpoint must be documented in `src/docs/openapi.ts`
  (served at `/api/docs`). Reuse the controllers' exported zod schemas for request bodies.
- Verify each feature end to end against the real Supabase project before calling it done; clean up test data.

## Stack
- Node + Express 5 + TypeScript (ESM, `nodenext`: relative imports need `.js`), run with `tsx`.
- Supabase: Auth (Google OAuth only, PKCE handled server-side) + Postgres. Backend uses the service role key
  (`supabaseAdmin`); RLS is enabled on all tables with read-own policies only.
- SQL migrations live in `supabase/migrations/` and are applied manually in the Supabase SQL editor.

## Structure
- `src/config/env.ts`: env vars, fails fast if required ones are missing.
- `src/lib/supabase.ts`: `supabaseAdmin` + `createAuthClient()` (fresh client per auth op, never share sessions).
- `src/models/*`: DB access. `src/controllers/*`: validation + responses. `src/routes/*`: wiring.
- `src/middlewares/auth.middleware.ts`: `requireAuth`, `requireRole(...)`, `requireVenueAccess(...staffRoles)`.
- `src/utils/validation.ts`: shared regexes/helpers. `src/utils/http.ts`: `HttpError`, bearer/cookie helpers.
- Errors: Express 5 forwards async errors to the handler in `app.ts`; Postgres `23505` maps to 409.

## Domain (done)
- `profiles` (role: player | venue_owner | admin; status: active | suspended; onboarding = name + phone + city).
- `venue_owner_details`: owner applications, approved/rejected by admin via `review_venue_owner()` RPC.
- `venues` (minimal so far), `venue_staff` (manager | staff), `venue_staff_invites` (claimed on sign-up by trigger).

- Phase 1 (`002_venues.sql`): `sports`/`amenities` catalogs, `venues` (status draft → pending_review → live,
  rejected, suspended; PostGIS `location` generated from lat/lng; soft delete via `deleted_at`), `courts`
  (bookable unit; base slot 30/60, min/max duration multiples), `venue_photos` (Cloudflare R2 via `src/lib/r2.ts`; compressed to WebP 1600px + 480px `-thumb` by `src/lib/image.ts`; max 15,
  one cover). All transitions go through `transition_venue()`; public search via `search_venues()`.
- DB invariants: listed venues keep required fields, ≥1 photo, ≥1 active court (triggers/RPCs raise `P0001`).
- SQL functions are **revoked from anon/authenticated** (Supabase exposes them via REST otherwise); grant only
  to `service_role`. Default privileges already revoke new functions; still add explicit revoke/grant lines.
- Lock order in SQL: court → venue → profile (never the reverse; avoids deadlocks).
- Errors: `P0001` → 409 with the SQL message, `P0002` → 404.
- Validation: zod via `parse()` in `src/utils/validate.ts`; use `z.strictObject` for bodies.

- Phase 2 (`003_availability.sql`): venue `booking_window_days` (1-7) / `listing_window_days` (<=30) /
  `min_notice_minutes`; `opening_hours` (venue-wide or per court, minutes from local midnight, may cross midnight);
  `price_rules` (weekly or date, per hour in **paise**; date > weekly > court base price); `court_blocks`
  (court_id null = venue closed); `get_availability()` computes slots in SQL (never stored); `slot_reminders` →
  `process_due_reminders()` → `notifications` + `notification_deliveries` outbox (email via Resend, push via FCM),
  sent by `src/jobs/notifications.job.ts` (lease-based claiming, retries with backoff, safe on many instances).
- Permissions: owner = everything; manager = venue details, courts, photos, hours, pricing, blocks;
  staff = blocks + read. Owner only: delete venue, submit/unpublish, staff management.

- Phase 3 (`004_bookings.sql`): `bookings` with exclusion constraint `bookings_no_overlap` (court + tstzrange,
  ignoring cancelled/expired) = no double booking. Methods: `online` (10% platform-funded discount, 10-min
  `pending_payment` hold), `pay_at_venue` (only inside venue `pay_at_venue_window_minutes`, switchable per venue,
  max ONE upcoming per player), `offline` (staff walk-in). `prepare_booking()` validates + prices (quote),
  `create_booking()` (idempotent per user+key), `cancel_booking()` (player: policy snapshot refund; venue/admin:
  full refund), check-in / collect / manual no-show (+undo 24h). `booking_events` logs every status change.
  `process_booking_jobs()` expires holds, completes finished bookings, sends 2h game reminders.
  Guards: blocks can't cover bookings; courts can't be deactivated/deleted/change sport or slot length, venues
  can't be deleted/unpublished with upcoming bookings; admin suspension cancels them with full refunds.
- Staff cancel of bookings: owner/manager only. Everything else at the front desk: any staff.

- Phase 4 (`006_payments.sql`): Razorpay via plain HTTPS (`src/lib/razorpay.ts`, `RAZORPAY_API_BASE` overridable
  for tests). `payments` (per order), `refunds` (max one per payment, outbox with lease + retries; retries first
  look for an existing Razorpay refund tagged with our id), `webhook_events` (dedupe). `record_payment_captured()`
  confirms the booking or queues an automatic refund (amount mismatch, duplicate, cancelled, started, slot taken /
  blocked / venue not live when reviving a lapsed hold). Hold: players see 10 min, slot released after +5 min grace.
  Webhook at `/api/payments/webhook` uses the raw body. Job reconciles orders with no final state (lost webhooks).
- Money: commission 10% (`platform_commission_percent()`, snapshot `bookings.commission_percent`). One
  `venue_ledger` row per booking, recomputed by trigger (`booking_venue_net()`): online credits subtotal - commission
  when final (partial on player cancellation); completed pay-at-venue debits commission; walk-ins nothing.
  Payouts: `manual` (admin records transfer + UTR) or `route` (daily automatic Razorpay transfer of the balance;
  unknown outcomes stay `processing` for admin resolve, never retried automatically).

## Roadmap
1. Venues & courts (browse, owner CRUD, photos, admin review) ← done
2. Availability & pricing (hours, price rules, blocks, computed slots, reminders, notifications) ← done
3. Bookings (exclusion constraint against double booking, holds, staff check-in, cancellation policy) ← done
4. Payments (Razorpay, webhooks, refunds, payouts) ← done
5. Reviews, favourites, notifications, owner dashboard
