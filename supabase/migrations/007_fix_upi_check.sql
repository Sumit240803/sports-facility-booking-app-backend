-- Postgres regex repetition counts max out at 255, so {2,256} made every UPI id insert fail.
-- UPI handles are short in practice; allow 2-64 characters before the @.
alter table public.venue_payout_settings drop constraint if exists venue_payout_settings_upi_id_check;
alter table public.venue_payout_settings
    add constraint venue_payout_settings_upi_id_check check (upi_id ~ '^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,64}$');
