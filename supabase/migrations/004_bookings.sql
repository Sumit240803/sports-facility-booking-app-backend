-- ============================================================
-- Phase 3: bookings
--   online        -> pending_payment (10 min hold) -> confirmed after payment (Phase 4)
--   pay_at_venue  -> confirmed immediately; only inside the venue's pay-at-venue window,
--                    one upcoming pay-at-venue booking per player
--   offline       -> staff walk-in / phone booking, confirmed immediately
-- Double booking is impossible: exclusion constraint on (court, time range).
-- ============================================================

create extension if not exists btree_gist with schema extensions;

-- ------------------------------------------------------------
-- Venue booking settings
-- ------------------------------------------------------------
alter table public.venues
    add column pay_at_venue_enabled boolean not null default true,
    add column pay_at_venue_window_minutes int not null default 60 check (pay_at_venue_window_minutes between 15 and 720),
    add column cancellation_policy jsonb not null default
        '[{"hours_before": 24, "refund_percent": 100}, {"hours_before": 6, "refund_percent": 50}]'::jsonb;

-- ------------------------------------------------------------
-- Bookings
-- ------------------------------------------------------------
create type public.booking_status as enum ('pending_payment', 'confirmed', 'checked_in', 'completed', 'cancelled', 'expired', 'no_show');
create type public.payment_method as enum ('online', 'pay_at_venue', 'offline');
create type public.booking_payment_status as enum ('pending', 'paid', 'due', 'collected');
create type public.refund_status as enum ('none', 'pending', 'processed', 'failed');

create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    reference text not null unique,
    venue_id uuid not null references public.venues (id),
    court_id uuid not null references public.courts (id),
    user_id uuid references public.profiles (id) on delete set null,
    customer_name text check (char_length(customer_name) <= 100),
    customer_phone text check (char_length(customer_phone) <= 20),
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    during tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,
    slot_date date not null, -- availability date the booking was made under (venue-local)
    duration_minutes int not null check (duration_minutes between 30 and 720),
    status public.booking_status not null,
    payment_method public.payment_method not null,
    payment_status public.booking_payment_status not null,
    subtotal_paise int not null check (subtotal_paise >= 0),
    discount_percent smallint not null default 0 check (discount_percent between 0 and 100),
    discount_paise int not null default 0 check (discount_paise >= 0),
    total_paise int not null check (total_paise >= 0),
    slots jsonb not null,
    cancellation_policy jsonb not null,
    expires_at timestamptz,
    idempotency_key text check (char_length(idempotency_key) <= 100),
    notes text check (char_length(notes) <= 500),
    created_by uuid references public.profiles (id) on delete set null,
    checked_in_at timestamptz,
    checked_in_by uuid references public.profiles (id) on delete set null,
    collected_paise int check (collected_paise >= 0),
    cancelled_at timestamptz,
    cancelled_by uuid references public.profiles (id) on delete set null,
    cancelled_by_role text check (cancelled_by_role in ('player', 'venue', 'admin', 'system')),
    cancel_reason text check (char_length(cancel_reason) <= 500),
    refund_percent smallint check (refund_percent between 0 and 100),
    refund_paise int check (refund_paise >= 0),
    refund_status public.refund_status not null default 'none',
    game_reminder_sent_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint bookings_range check (ends_at > starts_at),
    constraint bookings_total check (total_paise = subtotal_paise - discount_paise),
    constraint bookings_no_overlap exclude using gist (court_id with =, during with &&)
        where (status not in ('cancelled', 'expired'))
);

create unique index bookings_idempotency_idx on public.bookings (user_id, idempotency_key) where idempotency_key is not null;
create index bookings_venue_time_idx on public.bookings (venue_id, starts_at);
create index bookings_court_time_idx on public.bookings (court_id, starts_at);
create index bookings_user_idx on public.bookings (user_id, starts_at desc);
create index bookings_pending_idx on public.bookings (expires_at) where status = 'pending_payment';
create index bookings_active_end_idx on public.bookings (ends_at) where status in ('confirmed', 'checked_in');
create index bookings_reminder_idx on public.bookings (starts_at) where status in ('confirmed', 'checked_in') and game_reminder_sent_at is null;

create trigger bookings_set_updated_at
    before update on public.bookings
    for each row execute function public.set_updated_at();

-- Every status change is recorded
create table public.booking_events (
    id bigint generated always as identity primary key,
    booking_id uuid not null references public.bookings (id) on delete cascade,
    from_status public.booking_status,
    to_status public.booking_status not null,
    actor_id uuid,
    note text,
    created_at timestamptz not null default now()
);

create index booking_events_booking_idx on public.booking_events (booking_id, id);

create or replace function public.bookings_log_event()
returns trigger
language plpgsql
as $$
begin
    if tg_op = 'INSERT' then
        insert into public.booking_events (booking_id, from_status, to_status, actor_id)
        values (new.id, null, new.status, new.created_by);
    elsif new.status is distinct from old.status then
        insert into public.booking_events (booking_id, from_status, to_status, actor_id, note)
        values (new.id, old.status, new.status,
                coalesce(nullif(current_setting('easyplay.actor_id', true), '')::uuid, null),
                nullif(current_setting('easyplay.event_note', true), ''));
    end if;
    return new;
end;
$$;

create trigger bookings_log_event
    after insert or update on public.bookings
    for each row execute function public.bookings_log_event();

-- A booking that currently holds its time
create or replace function public.booking_is_active(p_status public.booking_status, p_expires_at timestamptz)
returns boolean
language sql
stable
as $$
    select p_status in ('confirmed', 'checked_in', 'completed', 'no_show')
        or (p_status = 'pending_payment' and p_expires_at > now());
$$;

-- ------------------------------------------------------------
-- Notifications helper: in-app + email/push deliveries per user preference
-- ------------------------------------------------------------
create or replace function public.notify_user(p_user_id uuid, p_type text, p_title text, p_body text, p_data jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
    n_id uuid;
    prefs record;
begin
    if p_user_id is null then return; end if;
    select email, notify_email, notify_push, status into prefs from public.profiles where id = p_user_id;
    if prefs is null or prefs.status <> 'active' then return; end if;

    insert into public.notifications (user_id, type, title, body, data)
    values (p_user_id, p_type, p_title, p_body, coalesce(p_data, '{}'))
    returning id into n_id;

    if prefs.notify_email and prefs.email is not null then
        insert into public.notification_deliveries (notification_id, channel) values (n_id, 'email');
    end if;
    if prefs.notify_push and exists (select 1 from public.push_tokens where user_id = p_user_id) then
        insert into public.notification_deliveries (notification_id, channel) values (n_id, 'push');
    end if;
end;
$$;

create or replace function public.booking_notification_text(b public.bookings)
returns text
language sql
stable
security definer set search_path = public
as $$
    select format('%s at %s, %s', c.name, v.name,
                  to_char(b.starts_at at time zone v.timezone, 'Dy DD Mon, HH12:MI AM'))
      from public.courts c join public.venues v on v.id = c.venue_id
     where c.id = b.court_id;
$$;

-- ------------------------------------------------------------
-- Availability: adds 'booked' status and whether pay-at-venue is open per slot
-- ------------------------------------------------------------
drop function public.get_availability(uuid, date, uuid);

create function public.get_availability(p_venue_id uuid, p_date date, p_court_id uuid default null)
returns table (
    court_id uuid,
    slot_start timestamptz,
    slot_end timestamptz,
    price_paise int,
    status text,
    opens_at timestamptz,
    pay_at_venue_open boolean
)
language sql
stable
security definer set search_path = public
as $$
    with v as (
        select id, timezone, booking_window_days, min_notice_minutes, pay_at_venue_enabled, pay_at_venue_window_minutes
          from public.venues where id = p_venue_id and deleted_at is null
    ),
    today as (
        select (now() at time zone v.timezone)::date as d from v
    ),
    c as (
        select c.* from public.courts c
         where c.venue_id = p_venue_id and c.is_active and c.deleted_at is null
           and c.price_per_hour_paise is not null
           and (p_court_id is null or c.id = p_court_id)
    ),
    ranges as (
        select c.id as court_id, c.base_slot_minutes, h.start_minute, h.end_minute
          from c
          join public.opening_hours h
            on h.venue_id = p_venue_id
           and h.day_of_week = extract(dow from p_date)::smallint
           and ((c.uses_venue_hours and h.court_id is null) or (not c.uses_venue_hours and h.court_id = c.id))
    ),
    slots as (
        select r.court_id, r.base_slot_minutes,
               p_date::timestamp + make_interval(mins => m) as local_start,
               p_date::timestamp + make_interval(mins => m + r.base_slot_minutes) as local_end
          from ranges r
         cross join lateral generate_series(r.start_minute, r.end_minute - r.base_slot_minutes, r.base_slot_minutes) as m
    ),
    evaluated as (
        select s.court_id,
               s.local_start at time zone v.timezone as slot_start,
               s.local_end at time zone v.timezone as slot_end,
               round(public.court_price_per_hour(s.court_id, s.local_start::date,
                     (extract(hour from s.local_start) * 60 + extract(minute from s.local_start))::int)
                     * s.base_slot_minutes / 60.0)::int as price_paise,
               case
                   when s.local_start at time zone v.timezone <= now() then 'past'
                   when exists (
                       select 1 from public.bookings bk
                        where bk.court_id = s.court_id
                          and public.booking_is_active(bk.status, bk.expires_at)
                          and bk.during && tstzrange(s.local_start at time zone v.timezone, s.local_end at time zone v.timezone, '[)')
                   ) then 'booked'
                   when exists (
                       select 1 from public.court_blocks b
                        where b.venue_id = p_venue_id
                          and (b.court_id is null or b.court_id = s.court_id)
                          and b.starts_at < s.local_end at time zone v.timezone
                          and b.ends_at > s.local_start at time zone v.timezone
                   ) then 'blocked'
                   when s.local_start at time zone v.timezone < now() + make_interval(mins => v.min_notice_minutes) then 'closed'
                   when s.local_start::date > t.d + (v.booking_window_days - 1) then 'not_yet_open'
                   else 'available'
               end as status,
               (s.local_start::date - (v.booking_window_days - 1))::timestamp at time zone v.timezone as opens_at,
               v.pay_at_venue_enabled
                   and s.local_start at time zone v.timezone <= now() + make_interval(mins => v.pay_at_venue_window_minutes) as in_pav_window
          from slots s
         cross join v
         cross join today t
    )
    select e.court_id, e.slot_start, e.slot_end, e.price_paise, e.status, e.opens_at,
           (e.status = 'available' and e.in_pav_window) as pay_at_venue_open
      from evaluated e
     order by e.court_id, e.slot_start;
$$;

-- ------------------------------------------------------------
-- Booking references like EP-7K3M9Q (no 0/O/1/I/L to avoid misreading)
-- ------------------------------------------------------------
create or replace function public.generate_booking_reference()
returns text
language plpgsql
volatile
as $$
declare
    alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    ref text;
begin
    loop
        ref := 'EP-' || (
            select string_agg(substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1), '')
              from generate_series(1, 6)
        );
        exit when not exists (select 1 from public.bookings where reference = ref);
    end loop;
    return ref;
end;
$$;

-- ------------------------------------------------------------
-- Validates a booking request and prices it. Shared by quote and create.
-- p_method: online | pay_at_venue | offline
-- ------------------------------------------------------------
create or replace function public.prepare_booking(
    p_user_id uuid,
    p_court_id uuid,
    p_date date,
    p_start timestamptz,
    p_duration int,
    p_method text,
    p_discount_percent int
)
returns jsonb
language plpgsql
stable
security definer set search_path = public
as $$
declare
    c public.courts;
    v public.venues;
    s record;
    expected_start timestamptz := p_start;
    slot_count int := 0;
    subtotal int := 0;
    slot_list jsonb := '[]'::jsonb;
    discount int;
begin
    select * into c from public.courts where id = p_court_id and deleted_at is null;
    if c.id is null or not c.is_active then
        raise exception 'Court not found' using errcode = 'P0002';
    end if;
    select * into v from public.venues where id = c.venue_id and deleted_at is null;
    if v.id is null or v.status <> 'live' then
        raise exception 'Venue is not accepting bookings' using errcode = 'P0001';
    end if;
    if p_method <> 'offline' and not exists (
        select 1 from public.profiles p where p.id = v.owner_id and p.status = 'active' and p.role in ('venue_owner', 'admin')
    ) then
        raise exception 'Venue is not accepting bookings' using errcode = 'P0001';
    end if;

    if p_duration % c.base_slot_minutes <> 0 then
        raise exception 'Duration must be a multiple of % minutes', c.base_slot_minutes using errcode = 'P0001';
    end if;
    if p_duration < c.min_duration_minutes or p_duration > c.max_duration_minutes then
        raise exception 'Duration must be between % and % minutes', c.min_duration_minutes, c.max_duration_minutes using errcode = 'P0001';
    end if;

    for s in
        select * from public.get_availability(v.id, p_date, p_court_id) a
         where a.slot_start >= p_start and a.slot_start < p_start + make_interval(mins => p_duration)
         order by a.slot_start
    loop
        if s.slot_start <> expected_start then
            if slot_count = 0 then
                raise exception 'No bookable slot starts at the selected time' using errcode = 'P0002';
            end if;
            raise exception 'The selected time is not continuous opening time' using errcode = 'P0001';
        end if;

        if s.status = 'booked' then
            raise exception 'Slot at % is already booked', to_char(s.slot_start at time zone v.timezone, 'HH12:MI AM') using errcode = 'P0001';
        elsif s.status = 'blocked' then
            raise exception 'Slot at % is not available', to_char(s.slot_start at time zone v.timezone, 'HH12:MI AM') using errcode = 'P0001';
        elsif p_method = 'offline' then
            -- staff may book anything listed that is not over yet (walk-ins can join a running slot)
            if s.status = 'past' and s.slot_end <= now() then
                raise exception 'Slot at % is already over', to_char(s.slot_start at time zone v.timezone, 'HH12:MI AM') using errcode = 'P0001';
            end if;
        elsif s.status = 'not_yet_open' then
            raise exception 'Booking for this date opens at %', to_char(s.opens_at at time zone v.timezone, 'DD Mon HH12:MI AM') using errcode = 'P0001';
        elsif s.status <> 'available' then
            raise exception 'Slot at % can no longer be booked', to_char(s.slot_start at time zone v.timezone, 'HH12:MI AM') using errcode = 'P0001';
        end if;

        slot_list := slot_list || jsonb_build_object('start', s.slot_start, 'end', s.slot_end, 'price_paise', s.price_paise);
        subtotal := subtotal + s.price_paise;
        slot_count := slot_count + 1;
        expected_start := s.slot_end;
    end loop;

    if slot_count = 0 then
        raise exception 'No bookable slot starts at the selected time' using errcode = 'P0002';
    end if;
    if slot_count * c.base_slot_minutes <> p_duration then
        raise exception 'The venue is not open for the whole selected duration' using errcode = 'P0001';
    end if;

    if p_method = 'pay_at_venue' then
        if not v.pay_at_venue_enabled then
            raise exception 'This venue accepts online payment only' using errcode = 'P0001';
        end if;
        if p_start > now() + make_interval(mins => v.pay_at_venue_window_minutes) then
            raise exception 'Pay at venue opens % minutes before the slot; please pay online', v.pay_at_venue_window_minutes using errcode = 'P0001';
        end if;
        if exists (
            select 1 from public.bookings
             where user_id = p_user_id and payment_method = 'pay_at_venue'
               and status in ('confirmed', 'checked_in') and ends_at > now()
        ) then
            raise exception 'You already have an upcoming pay-at-venue booking; pay online or finish that one first' using errcode = 'P0001';
        end if;
    end if;

    discount := case when p_method = 'online' then round(subtotal * p_discount_percent / 100.0)::int else 0 end;

    return jsonb_build_object(
        'venue_id', v.id,
        'court_id', c.id,
        'slot_date', p_date,
        'starts_at', p_start,
        'ends_at', expected_start,
        'duration_minutes', p_duration,
        'payment_method', p_method,
        'slots', slot_list,
        'subtotal_paise', subtotal,
        'discount_percent', case when p_method = 'online' then p_discount_percent else 0 end,
        'discount_paise', discount,
        'total_paise', subtotal - discount,
        'cancellation_policy', v.cancellation_policy,
        'timezone', v.timezone
    );
end;
$$;

-- ------------------------------------------------------------
-- Creates a booking atomically. Idempotent per (user, key).
-- ------------------------------------------------------------
create or replace function public.create_booking(
    p_user_id uuid,
    p_actor_id uuid,
    p_court_id uuid,
    p_date date,
    p_start timestamptz,
    p_duration int,
    p_method text,
    p_discount_percent int,
    p_hold_minutes int,
    p_customer_name text default null,
    p_customer_phone text default null,
    p_notes text default null,
    p_idempotency_key text default null
)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
    existing public.bookings;
    q jsonb;
    b public.bookings;
begin
    if p_idempotency_key is not null and p_user_id is not null then
        select * into existing from public.bookings where user_id = p_user_id and idempotency_key = p_idempotency_key;
        if existing.id is not null then
            return existing;
        end if;
    end if;

    -- Serialize bookings per court and per user (the exclusion constraint is the final guard)
    perform 1 from public.courts where id = p_court_id for update;
    if p_user_id is not null then
        perform 1 from public.profiles where id = p_user_id for update;
    end if;

    -- Free holds that have run out, so they don't block this booking
    update public.bookings set status = 'expired'
     where court_id = p_court_id and status = 'pending_payment' and expires_at <= now();

    if p_method = 'online' and (
        select count(*) from public.bookings
         where user_id = p_user_id and status = 'pending_payment' and expires_at > now()
    ) >= 2 then
        raise exception 'Finish or cancel your pending payments before booking more' using errcode = 'P0001';
    end if;

    q := public.prepare_booking(p_user_id, p_court_id, p_date, p_start, p_duration, p_method, p_discount_percent);

    begin
        insert into public.bookings (
            reference, venue_id, court_id, user_id, customer_name, customer_phone,
            starts_at, ends_at, slot_date, duration_minutes,
            status, payment_method, payment_status,
            subtotal_paise, discount_percent, discount_paise, total_paise,
            slots, cancellation_policy, expires_at, idempotency_key, notes, created_by
        ) values (
            public.generate_booking_reference(), (q ->> 'venue_id')::uuid, p_court_id, p_user_id,
            p_customer_name, p_customer_phone,
            p_start, (q ->> 'ends_at')::timestamptz, p_date, p_duration,
            case when p_method = 'online' then 'pending_payment' else 'confirmed' end::public.booking_status,
            p_method::public.payment_method,
            case when p_method = 'online' then 'pending' else 'due' end::public.booking_payment_status,
            (q ->> 'subtotal_paise')::int, (q ->> 'discount_percent')::smallint, (q ->> 'discount_paise')::int, (q ->> 'total_paise')::int,
            q -> 'slots', q -> 'cancellation_policy',
            case when p_method = 'online' then now() + make_interval(mins => p_hold_minutes) end,
            p_idempotency_key, p_notes, p_actor_id
        )
        returning * into b;
    exception
        when exclusion_violation then
            raise exception 'Slot is already booked' using errcode = 'P0001';
        when unique_violation then
            -- concurrent retry with the same idempotency key
            select * into existing from public.bookings where user_id = p_user_id and idempotency_key = p_idempotency_key;
            if existing.id is not null then return existing; end if;
            raise;
    end;

    -- Reminders for these slots are pointless now
    update public.slot_reminders set status = 'cancelled'
     where court_id = p_court_id and status = 'pending'
       and slot_start >= b.starts_at and slot_start < b.ends_at;

    if b.status = 'confirmed' and b.user_id is not null then
        perform public.notify_user(b.user_id, 'booking_confirmed', 'Booking confirmed',
            format('%s is confirmed. Ref %s. Pay at the venue.', public.booking_notification_text(b), b.reference),
            jsonb_build_object('booking_id', b.id, 'reference', b.reference));
    end if;

    return b;
end;
$$;

-- ------------------------------------------------------------
-- Refund percent from a policy snapshot for a cancellation now
-- policy: [{hours_before, refund_percent}, ...]; first tier whose hours_before is met wins
-- ------------------------------------------------------------
create or replace function public.policy_refund_percent(p_policy jsonb, p_starts_at timestamptz)
returns int
language sql
stable
as $$
    select coalesce((
        select (t ->> 'refund_percent')::int
          from jsonb_array_elements(p_policy) t
         where extract(epoch from (p_starts_at - now())) / 3600 >= (t ->> 'hours_before')::numeric
         order by (t ->> 'hours_before')::numeric desc
         limit 1
    ), 0);
$$;

-- ------------------------------------------------------------
-- Cancel. p_role: player | venue | admin | system
--   player: own booking, before it starts, refund by the booking's policy
--   venue/admin/system: before it ends, always a full refund of what was paid
-- ------------------------------------------------------------
create or replace function public.cancel_booking(p_booking_id uuid, p_actor_id uuid, p_role text, p_reason text default null)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
    b public.bookings;
    pct int;
begin
    select * into b from public.bookings where id = p_booking_id for update;
    if b.id is null or (p_role = 'player' and b.user_id is distinct from p_actor_id) then
        raise exception 'Booking not found' using errcode = 'P0002';
    end if;
    if b.status not in ('pending_payment', 'confirmed') then
        raise exception 'A % booking cannot be cancelled', replace(b.status::text, '_', ' ') using errcode = 'P0001';
    end if;
    if b.status = 'pending_payment' and b.expires_at <= now() then
        raise exception 'This booking has already expired' using errcode = 'P0001';
    end if;
    if p_role = 'player' and b.starts_at <= now() then
        raise exception 'Bookings cannot be cancelled after they start' using errcode = 'P0001';
    end if;
    if p_role <> 'player' and b.ends_at <= now() then
        raise exception 'This booking is already over' using errcode = 'P0001';
    end if;
    if p_role <> 'player' and coalesce(trim(p_reason), '') = '' then
        raise exception 'A reason is required' using errcode = 'P0001';
    end if;

    pct := case
        when b.payment_status <> 'paid' then 0
        when p_role = 'player' then public.policy_refund_percent(b.cancellation_policy, b.starts_at)
        else 100
    end;

    perform set_config('easyplay.actor_id', coalesce(p_actor_id::text, ''), true);
    perform set_config('easyplay.event_note', coalesce(p_reason, ''), true);

    update public.bookings
       set status = 'cancelled',
           cancelled_at = now(),
           cancelled_by = p_actor_id,
           cancelled_by_role = p_role,
           cancel_reason = nullif(trim(p_reason), ''),
           refund_percent = case when payment_status = 'paid' then pct end,
           refund_paise = case when payment_status = 'paid' then round(total_paise * pct / 100.0)::int end,
           refund_status = case when payment_status = 'paid' and pct > 0 then 'pending' else 'none' end::public.refund_status
     where id = b.id
    returning * into b;

    if p_role <> 'player' and b.user_id is not null then
        perform public.notify_user(b.user_id, 'booking_cancelled', 'Booking cancelled by the venue',
            format('%s was cancelled: %s.%s', public.booking_notification_text(b), b.cancel_reason,
                   case when b.refund_paise > 0 then format(' A full refund of ₹%s is on its way.', to_char(b.refund_paise / 100.0, 'FM999999990.00')) else '' end),
            jsonb_build_object('booking_id', b.id, 'reference', b.reference));
    end if;
    return b;
end;
$$;

-- ------------------------------------------------------------
-- Staff operations
-- ------------------------------------------------------------

-- Check-in from 30 min before start until the end; optionally record cash/UPI collected at the venue
create or replace function public.check_in_booking(p_booking_id uuid, p_venue_id uuid, p_actor_id uuid, p_collected_paise int default null)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
    b public.bookings;
begin
    select * into b from public.bookings where id = p_booking_id and venue_id = p_venue_id for update;
    if b.id is null then
        raise exception 'Booking not found' using errcode = 'P0002';
    end if;
    if b.status <> 'confirmed' then
        raise exception 'Only confirmed bookings can be checked in (this one is %)', replace(b.status::text, '_', ' ') using errcode = 'P0001';
    end if;
    if now() < b.starts_at - interval '30 minutes' then
        raise exception 'Check-in opens 30 minutes before the booking' using errcode = 'P0001';
    end if;
    if now() >= b.ends_at then
        raise exception 'This booking is already over' using errcode = 'P0001';
    end if;
    if p_collected_paise is not null and b.payment_status <> 'due' then
        raise exception 'This booking has nothing to collect' using errcode = 'P0001';
    end if;

    perform set_config('easyplay.actor_id', p_actor_id::text, true);
    update public.bookings
       set status = 'checked_in',
           checked_in_at = now(),
           checked_in_by = p_actor_id,
           payment_status = case when p_collected_paise is not null then 'collected' else payment_status end,
           collected_paise = coalesce(p_collected_paise, collected_paise)
     where id = b.id
    returning * into b;
    return b;
end;
$$;

-- Record payment collected at the venue (any time after check-in or for walk-ins)
create or replace function public.collect_booking_payment(p_booking_id uuid, p_venue_id uuid, p_actor_id uuid, p_amount_paise int)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
    b public.bookings;
begin
    select * into b from public.bookings where id = p_booking_id and venue_id = p_venue_id for update;
    if b.id is null then
        raise exception 'Booking not found' using errcode = 'P0002';
    end if;
    if b.payment_status <> 'due' then
        raise exception 'This booking has nothing to collect' using errcode = 'P0001';
    end if;
    if b.status in ('cancelled', 'expired') then
        raise exception 'This booking is %', b.status using errcode = 'P0001';
    end if;
    update public.bookings set payment_status = 'collected', collected_paise = p_amount_paise
     where id = b.id
    returning * into b;
    return b;
end;
$$;

-- Manual no-show: after the start, until 24h after the end, if the player never checked in
create or replace function public.mark_no_show(p_booking_id uuid, p_venue_id uuid, p_actor_id uuid)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
    b public.bookings;
begin
    select * into b from public.bookings where id = p_booking_id and venue_id = p_venue_id for update;
    if b.id is null then
        raise exception 'Booking not found' using errcode = 'P0002';
    end if;
    if b.status not in ('confirmed', 'completed') or b.checked_in_at is not null then
        raise exception 'Only bookings that were never checked in can be marked as no-show' using errcode = 'P0001';
    end if;
    if now() < b.starts_at then
        raise exception 'A booking can be marked as no-show only after it starts' using errcode = 'P0001';
    end if;
    if now() > b.ends_at + interval '24 hours' then
        raise exception 'No-show can be marked only within 24 hours after the booking ends' using errcode = 'P0001';
    end if;

    perform set_config('easyplay.actor_id', p_actor_id::text, true);
    update public.bookings set status = 'no_show' where id = b.id returning * into b;

    perform public.notify_user(b.user_id, 'booking_no_show', 'Marked as no-show',
        format('%s was marked as a no-show. If this is a mistake, contact the venue.', public.booking_notification_text(b)),
        jsonb_build_object('booking_id', b.id, 'reference', b.reference));
    return b;
end;
$$;

-- Undo a no-show (player did come) within 24h after the end
create or replace function public.undo_no_show(p_booking_id uuid, p_venue_id uuid, p_actor_id uuid)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
    b public.bookings;
begin
    select * into b from public.bookings where id = p_booking_id and venue_id = p_venue_id for update;
    if b.id is null then
        raise exception 'Booking not found' using errcode = 'P0002';
    end if;
    if b.status <> 'no_show' then
        raise exception 'This booking is not marked as no-show' using errcode = 'P0001';
    end if;
    if now() > b.ends_at + interval '24 hours' then
        raise exception 'No-show can be undone only within 24 hours after the booking ends' using errcode = 'P0001';
    end if;

    perform set_config('easyplay.actor_id', p_actor_id::text, true);
    update public.bookings
       set status = case when now() >= ends_at then 'completed' else 'checked_in' end::public.booking_status,
           checked_in_at = now(),
           checked_in_by = p_actor_id
     where id = b.id
    returning * into b;
    return b;
end;
$$;

-- ------------------------------------------------------------
-- Background job: expire holds, complete finished bookings, send 2-hour game reminders
-- ------------------------------------------------------------
create or replace function public.process_booking_jobs(p_limit int)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
    expired_count int;
    completed_count int;
    reminded int := 0;
    b public.bookings;
begin
    with due as (
        select id from public.bookings
         where status = 'pending_payment' and expires_at <= now()
         limit p_limit for update skip locked
    )
    update public.bookings bk set status = 'expired' from due where bk.id = due.id;
    get diagnostics expired_count = row_count;

    with due as (
        select id from public.bookings
         where status in ('confirmed', 'checked_in') and ends_at <= now()
         limit p_limit for update skip locked
    )
    update public.bookings bk set status = 'completed' from due where bk.id = due.id;
    get diagnostics completed_count = row_count;

    for b in
        select * from public.bookings
         where status in ('confirmed', 'checked_in') and game_reminder_sent_at is null
           and starts_at > now() and starts_at <= now() + interval '2 hours'
         order by starts_at
         limit p_limit
         for update skip locked
    loop
        update public.bookings set game_reminder_sent_at = now() where id = b.id;
        -- Booked less than 2 hours ahead: the player already knows, skip the reminder
        if b.created_at <= b.starts_at - interval '2 hours' then
            perform public.notify_user(b.user_id, 'game_reminder', 'Your game starts soon',
                format('%s. Ref %s.', public.booking_notification_text(b), b.reference),
                jsonb_build_object('booking_id', b.id, 'reference', b.reference));
            reminded := reminded + 1;
        end if;
    end loop;

    return jsonb_build_object('expired', expired_count, 'completed', completed_count, 'reminded', reminded);
end;
$$;

-- ------------------------------------------------------------
-- Guards: nothing may silently break an upcoming booking
-- ------------------------------------------------------------
create or replace function public.has_upcoming_bookings(p_venue_id uuid, p_court_id uuid default null)
returns boolean
language sql
stable
security definer set search_path = public
as $$
    select exists (
        select 1 from public.bookings
         where venue_id = p_venue_id
           and (p_court_id is null or court_id = p_court_id)
           and ends_at > now()
           and public.booking_is_active(status, expires_at)
           and status <> 'completed' and status <> 'no_show'
    );
$$;

-- Blocks cannot cover an active booking
create or replace function public.court_blocks_guard_bookings()
returns trigger
language plpgsql
as $$
begin
    if exists (
        select 1 from public.bookings bk
         where bk.venue_id = new.venue_id
           and (new.court_id is null or bk.court_id = new.court_id)
           and bk.status in ('pending_payment', 'confirmed', 'checked_in')
           and public.booking_is_active(bk.status, bk.expires_at)
           and bk.during && tstzrange(new.starts_at, new.ends_at, '[)')
    ) then
        raise exception 'This time overlaps existing bookings; cancel them first' using errcode = 'P0001';
    end if;
    return new;
end;
$$;

create trigger court_blocks_guard_bookings
    before insert or update on public.court_blocks
    for each row execute function public.court_blocks_guard_bookings();

-- Courts: no deactivate/delete/sport or slot change with upcoming bookings
create or replace function public.courts_guard_bookings()
returns trigger
language plpgsql
as $$
begin
    if ((old.is_active and old.deleted_at is null) and not (new.is_active and new.deleted_at is null))
       or new.sport_id <> old.sport_id
       or new.base_slot_minutes <> old.base_slot_minutes then
        if public.has_upcoming_bookings(old.venue_id, old.id) then
            raise exception 'This court has upcoming bookings; cancel them first' using errcode = 'P0001';
        end if;
    end if;
    return new;
end;
$$;

create trigger courts_guard_bookings
    before update on public.courts
    for each row execute function public.courts_guard_bookings();

-- Venues: no delete / unpublish with upcoming bookings (suspension cancels them instead)
create or replace function public.venues_guard_bookings()
returns trigger
language plpgsql
as $$
begin
    if (new.deleted_at is not null and old.deleted_at is null)
       or (old.status = 'live' and new.status = 'draft') then
        if public.has_upcoming_bookings(old.id) then
            raise exception 'This venue has upcoming bookings; cancel them first' using errcode = 'P0001';
        end if;
    end if;
    return new;
end;
$$;

create trigger venues_guard_bookings
    before update on public.venues
    for each row execute function public.venues_guard_bookings();

-- ------------------------------------------------------------
-- transition_venue: suspension cancels upcoming bookings with full refunds + notifications
-- ------------------------------------------------------------
create or replace function public.transition_venue(p_venue_id uuid, p_action text, p_actor_id uuid, p_reason text default null)
returns public.venues
language plpgsql
security definer set search_path = public
as $$
declare
    v public.venues;
    required_status public.venue_status[];
    next_status public.venue_status;
    bk record;
begin
    select * into v from public.venues where id = p_venue_id and deleted_at is null for update;
    if v.id is null then
        raise exception 'Venue not found' using errcode = 'P0002';
    end if;

    case p_action
        when 'submit' then required_status := '{draft,rejected}'; next_status := 'pending_review';
        when 'unpublish' then required_status := '{live,pending_review}'; next_status := 'draft';
        when 'approve' then required_status := '{pending_review}'; next_status := 'live';
        when 'reject' then required_status := '{pending_review}'; next_status := 'rejected';
        when 'suspend' then required_status := '{live,pending_review}'; next_status := 'suspended';
        when 'reinstate' then required_status := '{suspended}'; next_status := 'live';
        else raise exception 'Unknown action %', p_action using errcode = 'P0001';
    end case;

    if not (v.status = any (required_status)) then
        raise exception 'Cannot % a venue that is %', p_action, v.status using errcode = 'P0001';
    end if;

    if p_action in ('reject', 'suspend') and coalesce(trim(p_reason), '') = '' then
        raise exception 'A reason is required' using errcode = 'P0001';
    end if;

    if next_status in ('pending_review', 'live') then
        if v.address_line is null or v.city is null or v.lat is null or v.phone is null then
            raise exception 'Venue needs address, city, map location and phone before it can be listed' using errcode = 'P0001';
        end if;
        if not exists (select 1 from public.venue_photos where venue_id = v.id) then
            raise exception 'Venue needs at least one photo before it can be listed' using errcode = 'P0001';
        end if;
        if not exists (select 1 from public.courts where venue_id = v.id and is_active and deleted_at is null) then
            raise exception 'Venue needs at least one active court before it can be listed' using errcode = 'P0001';
        end if;
        if exists (select 1 from public.courts where venue_id = v.id and is_active and deleted_at is null and price_per_hour_paise is null) then
            raise exception 'Every active court needs a price before the venue can be listed' using errcode = 'P0001';
        end if;
        if not exists (select 1 from public.opening_hours where venue_id = v.id and court_id is null) then
            raise exception 'Venue needs opening hours before it can be listed' using errcode = 'P0001';
        end if;
    end if;

    if p_action = 'suspend' then
        for bk in
            select id from public.bookings
             where venue_id = v.id and status in ('pending_payment', 'confirmed') and ends_at > now()
               and public.booking_is_active(status, expires_at)
        loop
            perform public.cancel_booking(bk.id, p_actor_id, 'admin', 'The venue is temporarily unavailable');
        end loop;
    end if;

    update public.venues
       set status = next_status,
           status_reason = case when p_action in ('reject', 'suspend') then trim(p_reason) else null end,
           submitted_at = case when p_action = 'submit' then now() else submitted_at end,
           reviewed_by = case when p_action in ('approve', 'reject', 'suspend', 'reinstate') then p_actor_id else reviewed_by end,
           reviewed_at = case when p_action in ('approve', 'reject', 'suspend', 'reinstate') then now() else reviewed_at end
     where id = v.id
    returning * into v;

    return v;
end;
$$;

-- ------------------------------------------------------------
-- Privileges: backend (service_role) only
-- ------------------------------------------------------------
revoke execute on function public.bookings_log_event() from public, anon, authenticated;
revoke execute on function public.booking_is_active(public.booking_status, timestamptz) from public, anon, authenticated;
revoke execute on function public.notify_user(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.booking_notification_text(public.bookings) from public, anon, authenticated;
revoke execute on function public.get_availability(uuid, date, uuid) from public, anon, authenticated;
revoke execute on function public.generate_booking_reference() from public, anon, authenticated;
revoke execute on function public.prepare_booking(uuid, uuid, date, timestamptz, int, text, int) from public, anon, authenticated;
revoke execute on function public.create_booking(uuid, uuid, uuid, date, timestamptz, int, text, int, int, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.policy_refund_percent(jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.cancel_booking(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.check_in_booking(uuid, uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.collect_booking_payment(uuid, uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.mark_no_show(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.undo_no_show(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.process_booking_jobs(int) from public, anon, authenticated;
revoke execute on function public.has_upcoming_bookings(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.court_blocks_guard_bookings() from public, anon, authenticated;
revoke execute on function public.courts_guard_bookings() from public, anon, authenticated;
revoke execute on function public.venues_guard_bookings() from public, anon, authenticated;
revoke execute on function public.transition_venue(uuid, text, uuid, text) from public, anon, authenticated;

grant execute on function public.booking_is_active(public.booking_status, timestamptz) to service_role;
grant execute on function public.notify_user(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.get_availability(uuid, date, uuid) to service_role;
grant execute on function public.prepare_booking(uuid, uuid, date, timestamptz, int, text, int) to service_role;
grant execute on function public.create_booking(uuid, uuid, uuid, date, timestamptz, int, text, int, int, text, text, text, text) to service_role;
grant execute on function public.policy_refund_percent(jsonb, timestamptz) to service_role;
grant execute on function public.cancel_booking(uuid, uuid, text, text) to service_role;
grant execute on function public.check_in_booking(uuid, uuid, uuid, int) to service_role;
grant execute on function public.collect_booking_payment(uuid, uuid, uuid, int) to service_role;
grant execute on function public.mark_no_show(uuid, uuid, uuid) to service_role;
grant execute on function public.undo_no_show(uuid, uuid, uuid) to service_role;
grant execute on function public.process_booking_jobs(int) to service_role;
grant execute on function public.has_upcoming_bookings(uuid, uuid) to service_role;
grant execute on function public.transition_venue(uuid, text, uuid, text) to service_role;

-- ------------------------------------------------------------
-- RLS: backend only; players can read their own bookings
-- ------------------------------------------------------------
alter table public.bookings enable row level security;
alter table public.booking_events enable row level security;

create policy "Users can read own bookings"
    on public.bookings for select
    using (auth.uid() = user_id);
