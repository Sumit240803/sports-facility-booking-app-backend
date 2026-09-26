-- ============================================================
-- Phase 2: opening hours, pricing, blocks/closures, availability,
--          slot reminders and notifications
-- Times: minutes from local midnight in the venue's timezone.
-- Money: integer paise (₹1 = 100).
-- ============================================================

-- ------------------------------------------------------------
-- Venue booking settings
-- ------------------------------------------------------------
alter table public.venues
    add column booking_window_days int not null default 7 check (booking_window_days between 1 and 7),
    add column listing_window_days int not null default 14 check (listing_window_days between 1 and 30),
    add column min_notice_minutes int not null default 30 check (min_notice_minutes between 0 and 1440),
    add constraint venues_listing_covers_booking check (listing_window_days >= booking_window_days);

-- ------------------------------------------------------------
-- Courts: base price and whether they follow the venue's hours
-- ------------------------------------------------------------
alter table public.courts
    add column price_per_hour_paise int check (price_per_hour_paise between 100 and 100000000),
    add column uses_venue_hours boolean not null default true;

-- ------------------------------------------------------------
-- Profiles: notification preferences
-- ------------------------------------------------------------
alter table public.profiles
    add column notify_email boolean not null default true,
    add column notify_push boolean not null default true;

-- ------------------------------------------------------------
-- Opening hours. court_id null = venue hours; set = that court's own hours
-- (used only when courts.uses_venue_hours = false).
-- end_minute may exceed 1440 for ranges that close after midnight (max 24h long).
-- ------------------------------------------------------------
create table public.opening_hours (
    id uuid primary key default gen_random_uuid(),
    venue_id uuid not null references public.venues (id) on delete cascade,
    court_id uuid references public.courts (id) on delete cascade,
    day_of_week smallint not null check (day_of_week between 0 and 6), -- 0 = Sunday
    start_minute int not null check (start_minute between 0 and 1439 and start_minute % 30 = 0),
    end_minute int not null check (end_minute % 30 = 0),
    constraint opening_hours_range check (end_minute > start_minute and end_minute - start_minute <= 1440)
);

create index opening_hours_venue_idx on public.opening_hours (venue_id, court_id, day_of_week);

-- ------------------------------------------------------------
-- Price rules per court. Either weekly (days) or for one date (on_date).
-- Date rules beat weekly rules; anything unmatched uses the court's base price.
-- Rules never cross midnight (split them into two).
-- ------------------------------------------------------------
create table public.price_rules (
    id uuid primary key default gen_random_uuid(),
    court_id uuid not null references public.courts (id) on delete cascade,
    days smallint[],
    on_date date,
    start_minute int not null check (start_minute between 0 and 1410 and start_minute % 30 = 0),
    end_minute int not null check (end_minute between 30 and 1440 and end_minute % 30 = 0),
    price_per_hour_paise int not null check (price_per_hour_paise between 100 and 100000000),
    created_at timestamptz not null default now(),
    constraint price_rules_kind check ((days is null) <> (on_date is null)),
    constraint price_rules_days check (days is null or (cardinality(days) between 1 and 7 and days <@ '{0,1,2,3,4,5,6}'::smallint[])),
    constraint price_rules_range check (end_minute > start_minute)
);

create index price_rules_court_idx on public.price_rules (court_id);

-- ------------------------------------------------------------
-- Blocks: court_id null = whole venue closed (e.g. a holiday)
-- ------------------------------------------------------------
create table public.court_blocks (
    id uuid primary key default gen_random_uuid(),
    venue_id uuid not null references public.venues (id) on delete cascade,
    court_id uuid references public.courts (id) on delete cascade,
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    reason text check (char_length(reason) <= 200),
    created_by uuid references public.profiles (id) on delete set null,
    created_at timestamptz not null default now(),
    constraint court_blocks_range check (ends_at > starts_at and ends_at - starts_at <= interval '62 days')
);

create index court_blocks_venue_idx on public.court_blocks (venue_id, ends_at);

-- ------------------------------------------------------------
-- Listed-venue invariants for Phase 2
-- ------------------------------------------------------------

-- An active court of a listed venue must have a price
create or replace function public.courts_guard_price()
returns trigger
language plpgsql
as $$
declare
    v_status public.venue_status;
begin
    if new.is_active and new.deleted_at is null and new.price_per_hour_paise is null then
        select status into v_status from public.venues where id = new.venue_id;
        if v_status in ('live', 'pending_review') then
            raise exception 'Active courts of a listed venue need a price' using errcode = 'P0001';
        end if;
    end if;
    return new;
end;
$$;

create trigger courts_guard_price
    before insert or update on public.courts
    for each row execute function public.courts_guard_price();

-- Validates a set of weekly ranges: no overlaps, including across midnight and Sunday -> Monday
create or replace function public.assert_no_weekly_overlap(p_ranges jsonb)
returns void
language plpgsql
immutable
as $$
begin
    if exists (
        with r as (
            select (e ->> 'day')::int * 1440 + (e ->> 'start')::int as s,
                   (e ->> 'day')::int * 1440 + (e ->> 'end')::int as f,
                   ord
              from jsonb_array_elements(p_ranges) with ordinality as t (e, ord)
        ),
        -- ranges that spill past the end of Saturday wrap to the start of the week
        expanded as (
            select s, f, ord from r
            union all
            select s - 10080, f - 10080, ord from r where f > 10080
        )
        select 1 from expanded a join expanded b on a.ord < b.ord
         where int4range(a.s, a.f) && int4range(b.s, b.f)
    ) then
        raise exception 'Opening hours overlap' using errcode = 'P0001';
    end if;
end;
$$;

-- Replaces venue hours (p_court_id null) or a court's own hours.
-- p_ranges: [{ "day": 0-6, "start": minutes, "end": minutes }]
create or replace function public.set_opening_hours(p_venue_id uuid, p_court_id uuid, p_ranges jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
    v_status public.venue_status;
begin
    select status into v_status from public.venues where id = p_venue_id and deleted_at is null for update;
    if v_status is null then
        raise exception 'Venue not found' using errcode = 'P0002';
    end if;
    if p_court_id is not null and not exists (
        select 1 from public.courts where id = p_court_id and venue_id = p_venue_id and deleted_at is null
    ) then
        raise exception 'Court not found' using errcode = 'P0002';
    end if;
    if jsonb_array_length(p_ranges) > 70 then
        raise exception 'Too many opening hour ranges' using errcode = 'P0001';
    end if;
    if p_court_id is null and jsonb_array_length(p_ranges) = 0 and v_status in ('live', 'pending_review') then
        raise exception 'A listed venue must have opening hours' using errcode = 'P0001';
    end if;

    perform public.assert_no_weekly_overlap(p_ranges);

    delete from public.opening_hours
     where venue_id = p_venue_id and court_id is not distinct from p_court_id;

    insert into public.opening_hours (venue_id, court_id, day_of_week, start_minute, end_minute)
    select p_venue_id, p_court_id, (e ->> 'day')::smallint, (e ->> 'start')::int, (e ->> 'end')::int
      from jsonb_array_elements(p_ranges) e;

    if p_court_id is not null then
        update public.courts set uses_venue_hours = false where id = p_court_id;
    end if;
end;
$$;

-- Court goes back to following the venue's hours
create or replace function public.reset_court_hours(p_venue_id uuid, p_court_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
    perform 1 from public.venues where id = p_venue_id for update;
    update public.courts set uses_venue_hours = true
     where id = p_court_id and venue_id = p_venue_id and deleted_at is null;
    if not found then
        raise exception 'Court not found' using errcode = 'P0002';
    end if;
    delete from public.opening_hours where venue_id = p_venue_id and court_id = p_court_id;
end;
$$;

-- Replaces a court's price rules.
-- p_rules: [{ "days": [0-6..] | null, "date": "YYYY-MM-DD" | null, "start": m, "end": m, "price": paise }]
create or replace function public.set_price_rules(p_venue_id uuid, p_court_id uuid, p_rules jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
    perform 1 from public.venues where id = p_venue_id for update;
    perform 1 from public.courts where id = p_court_id and venue_id = p_venue_id and deleted_at is null for update;
    if not found then
        raise exception 'Court not found' using errcode = 'P0002';
    end if;
    if jsonb_array_length(p_rules) > 100 then
        raise exception 'A court can have at most 100 price rules' using errcode = 'P0001';
    end if;

    if exists (
        with r as (
            select ord,
                   case when e -> 'days' is null or jsonb_typeof(e -> 'days') = 'null' then null
                        else array(select jsonb_array_elements_text(e -> 'days')::smallint) end as days,
                   nullif(e ->> 'date', '')::date as on_date,
                   (e ->> 'start')::int as s,
                   (e ->> 'end')::int as f
              from jsonb_array_elements(p_rules) with ordinality as t (e, ord)
        )
        select 1 from r a join r b on a.ord < b.ord
         where int4range(a.s, a.f) && int4range(b.s, b.f)
           and ((a.days is not null and b.days is not null and a.days && b.days)
             or (a.on_date is not null and a.on_date = b.on_date))
    ) then
        raise exception 'Price rules overlap' using errcode = 'P0001';
    end if;

    delete from public.price_rules where court_id = p_court_id;

    insert into public.price_rules (court_id, days, on_date, start_minute, end_minute, price_per_hour_paise)
    select p_court_id,
           case when e -> 'days' is null or jsonb_typeof(e -> 'days') = 'null' then null
                else array(select distinct jsonb_array_elements_text(e -> 'days')::smallint order by 1) end,
           nullif(e ->> 'date', '')::date,
           (e ->> 'start')::int,
           (e ->> 'end')::int,
           (e ->> 'price')::int
      from jsonb_array_elements(p_rules) e;
end;
$$;

-- Price per hour for a court at a local date + minute of day
create or replace function public.court_price_per_hour(p_court_id uuid, p_local_date date, p_minute int)
returns int
language sql
stable
security definer set search_path = public
as $$
    select coalesce(
        (select price_per_hour_paise from public.price_rules
          where court_id = p_court_id and on_date = p_local_date
            and p_minute >= start_minute and p_minute < end_minute
          limit 1),
        (select price_per_hour_paise from public.price_rules
          where court_id = p_court_id and on_date is null
            and extract(dow from p_local_date)::smallint = any (days)
            and p_minute >= start_minute and p_minute < end_minute
          limit 1),
        (select price_per_hour_paise from public.courts where id = p_court_id)
    );
$$;

-- ------------------------------------------------------------
-- Availability for one venue and one local date.
-- A slot belongs to the day its opening range starts on (Mon 18:00-02:00 -> Monday).
-- Status: past | blocked | closed (inside min notice) | not_yet_open (listed, not bookable yet) | available
-- Phase 3 adds 'booked'.
-- ------------------------------------------------------------
create or replace function public.get_availability(p_venue_id uuid, p_date date, p_court_id uuid default null)
returns table (
    court_id uuid,
    slot_start timestamptz,
    slot_end timestamptz,
    price_paise int,
    status text,
    opens_at timestamptz
)
language sql
stable
security definer set search_path = public
as $$
    with v as (
        select id, timezone, booking_window_days, min_notice_minutes
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
    )
    select s.court_id,
           s.local_start at time zone v.timezone as slot_start,
           s.local_end at time zone v.timezone as slot_end,
           round(public.court_price_per_hour(s.court_id, s.local_start::date,
                 (extract(hour from s.local_start) * 60 + extract(minute from s.local_start))::int)
                 * s.base_slot_minutes / 60.0)::int as price_paise,
           case
               when s.local_start at time zone v.timezone <= now() then 'past'
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
           (s.local_start::date - (v.booking_window_days - 1))::timestamp at time zone v.timezone as opens_at
      from slots s
     cross join v
     cross join today t
     order by s.court_id, s.local_start;
$$;

-- ------------------------------------------------------------
-- Notifications (in-app) + delivery outbox for email / push
-- ------------------------------------------------------------
create type public.notification_channel as enum ('email', 'push');
create type public.delivery_status as enum ('pending', 'processing', 'sent', 'failed', 'skipped');

create table public.notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    type text not null,
    title text not null,
    body text not null,
    data jsonb not null default '{}',
    read_at timestamptz,
    created_at timestamptz not null default now()
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

create table public.notification_deliveries (
    id uuid primary key default gen_random_uuid(),
    notification_id uuid not null references public.notifications (id) on delete cascade,
    channel public.notification_channel not null,
    status public.delivery_status not null default 'pending',
    attempts int not null default 0,
    next_attempt_at timestamptz not null default now(),
    locked_until timestamptz,
    last_error text,
    sent_at timestamptz,
    created_at timestamptz not null default now(),
    unique (notification_id, channel)
);

create index notification_deliveries_due_idx on public.notification_deliveries (next_attempt_at)
    where status in ('pending', 'processing');

create table public.push_tokens (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    token text not null unique check (char_length(token) between 10 and 4096),
    platform text not null check (platform in ('android', 'ios', 'web')),
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

create index push_tokens_user_idx on public.push_tokens (user_id);

-- Claims due deliveries with a lease so several server instances never send the same one twice
create or replace function public.claim_deliveries(p_limit int, p_lease_seconds int)
returns table (
    id uuid,
    channel public.notification_channel,
    attempts int,
    user_id uuid,
    email text,
    title text,
    body text,
    data jsonb
)
language plpgsql
security definer set search_path = public
as $$
begin
    return query
    with due as (
        select d.id from public.notification_deliveries d
         where (d.status = 'pending' and d.next_attempt_at <= now())
            or (d.status = 'processing' and d.locked_until < now())
         order by d.next_attempt_at
         limit p_limit
         for update skip locked
    ),
    claimed as (
        update public.notification_deliveries d
           set status = 'processing',
               attempts = d.attempts + 1,
               locked_until = now() + make_interval(secs => p_lease_seconds)
          from due
         where d.id = due.id
        returning d.id, d.channel, d.attempts, d.notification_id
    )
    select cl.id, cl.channel, cl.attempts, n.user_id, p.email, n.title, n.body, n.data
      from claimed cl
      join public.notifications n on n.id = cl.notification_id
      join public.profiles p on p.id = n.user_id;
end;
$$;

-- Records a delivery attempt. p_outcome: sent | skipped | failed (permanent) | retry (backoff, max 5 attempts)
create or replace function public.complete_delivery(p_id uuid, p_outcome text, p_error text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
    update public.notification_deliveries
       set status = case
               when p_outcome = 'sent' then 'sent'
               when p_outcome = 'skipped' then 'skipped'
               when p_outcome = 'failed' or attempts >= 5 then 'failed'
               else 'pending'
           end::public.delivery_status,
           sent_at = case when p_outcome = 'sent' then now() else sent_at end,
           next_attempt_at = case when p_outcome = 'retry' then now() + make_interval(secs => 60 * power(2, attempts)::int) else next_attempt_at end,
           locked_until = null,
           last_error = left(p_error, 500)
     where id = p_id;
end;
$$;

-- ------------------------------------------------------------
-- Slot reminders: "tell me when booking opens for this slot"
-- ------------------------------------------------------------
create type public.reminder_status as enum ('pending', 'sent', 'cancelled');

create table public.slot_reminders (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    venue_id uuid not null references public.venues (id) on delete cascade,
    court_id uuid not null references public.courts (id) on delete cascade,
    slot_start timestamptz not null,
    slot_date date not null, -- local date of the slot's opening day
    notify_at timestamptz not null,
    status public.reminder_status not null default 'pending',
    sent_at timestamptz,
    created_at timestamptz not null default now(),
    unique (user_id, court_id, slot_start)
);

create index slot_reminders_due_idx on public.slot_reminders (notify_at) where status = 'pending';
create index slot_reminders_user_idx on public.slot_reminders (user_id, status);
create index slot_reminders_venue_idx on public.slot_reminders (venue_id) where status = 'pending';

-- Creates a reminder for a listed-but-not-yet-bookable slot (validated against live availability)
create or replace function public.create_slot_reminder(p_user_id uuid, p_court_id uuid, p_date date, p_slot_start timestamptz)
returns public.slot_reminders
language plpgsql
security definer set search_path = public
as $$
declare
    v public.venues;
    s record;
    pending_count int;
    result public.slot_reminders;
begin
    select ven.* into v from public.venues ven
      join public.courts c on c.venue_id = ven.id
     where c.id = p_court_id and c.deleted_at is null and ven.deleted_at is null and ven.status = 'live';
    if v.id is null then
        raise exception 'Court not found' using errcode = 'P0002';
    end if;

    if p_date > (now() at time zone v.timezone)::date + (v.listing_window_days - 1) then
        raise exception 'This date is not listed yet' using errcode = 'P0001';
    end if;

    select * into s from public.get_availability(v.id, p_date, p_court_id) a where a.slot_start = p_slot_start;
    if s.slot_start is null then
        raise exception 'Slot not found' using errcode = 'P0002';
    end if;
    if s.status <> 'not_yet_open' then
        raise exception 'Reminders are only for slots whose booking has not opened yet (slot is %)', s.status using errcode = 'P0001';
    end if;

    perform 1 from public.profiles where id = p_user_id for update;
    select count(*) into pending_count from public.slot_reminders where user_id = p_user_id and status = 'pending';
    if pending_count >= 50 then
        raise exception 'You can have at most 50 active reminders' using errcode = 'P0001';
    end if;

    insert into public.slot_reminders (user_id, venue_id, court_id, slot_start, slot_date, notify_at)
    values (p_user_id, v.id, p_court_id, p_slot_start, p_date, s.opens_at)
    on conflict (user_id, court_id, slot_start) do update
        set status = 'pending', notify_at = excluded.notify_at, sent_at = null
        where public.slot_reminders.status <> 'pending'
    returning * into result;

    if result.id is null then
        raise exception 'You already have a reminder for this slot' using errcode = 'P0001';
    end if;
    return result;
end;
$$;

-- Keep pending reminders in sync when a venue changes its booking window or timezone
create or replace function public.venues_resync_reminders()
returns trigger
language plpgsql
as $$
begin
    if new.booking_window_days <> old.booking_window_days or new.timezone <> old.timezone then
        update public.slot_reminders
           set notify_at = (slot_date - (new.booking_window_days - 1))::timestamp at time zone new.timezone
         where venue_id = new.id and status = 'pending';
    end if;
    return new;
end;
$$;

create trigger venues_resync_reminders
    after update on public.venues
    for each row execute function public.venues_resync_reminders();

-- Turns due reminders into notifications (+ email/push deliveries). Safe to run concurrently.
create or replace function public.process_due_reminders(p_limit int)
returns int
language plpgsql
security definer set search_path = public
as $$
declare
    r record;
    n_id uuid;
    processed int := 0;
begin
    for r in
        select sr.id, sr.user_id, sr.court_id, sr.venue_id, sr.slot_start, sr.slot_date,
               c.name as court_name, c.base_slot_minutes, c.is_active as court_active, c.deleted_at as court_deleted,
               v.name as venue_name, v.slug as venue_slug, v.status as venue_status, v.deleted_at as venue_deleted, v.timezone,
               p.email, p.status as user_status, p.notify_email, p.notify_push
          from public.slot_reminders sr
          join public.courts c on c.id = sr.court_id
          join public.venues v on v.id = sr.venue_id
          join public.profiles p on p.id = sr.user_id
         where sr.status = 'pending' and sr.notify_at <= now()
         order by sr.notify_at
         limit p_limit
         for update of sr skip locked
    loop
        processed := processed + 1;

        -- Nothing to book any more: cancel silently
        if r.slot_start <= now() or not r.court_active or r.court_deleted is not null
           or r.venue_status <> 'live' or r.venue_deleted is not null or r.user_status <> 'active'
           or exists (
               select 1 from public.court_blocks b
                where b.venue_id = r.venue_id and (b.court_id is null or b.court_id = r.court_id)
                  and b.starts_at < r.slot_start + make_interval(mins => r.base_slot_minutes) and b.ends_at > r.slot_start
           )
        then
            update public.slot_reminders set status = 'cancelled' where id = r.id;
            continue;
        end if;

        insert into public.notifications (user_id, type, title, body, data)
        values (
            r.user_id,
            'booking_open',
            'Booking is open',
            format('%s at %s on %s is now open for booking.', r.court_name, r.venue_name,
                   to_char(r.slot_start at time zone r.timezone, 'Dy DD Mon, HH12:MI AM')),
            jsonb_build_object('venue_id', r.venue_id, 'venue_slug', r.venue_slug, 'court_id', r.court_id,
                               'date', r.slot_date, 'slot_start', r.slot_start, 'reminder_id', r.id)
        )
        returning id into n_id;

        if r.notify_email and r.email is not null then
            insert into public.notification_deliveries (notification_id, channel) values (n_id, 'email');
        end if;
        if r.notify_push and exists (select 1 from public.push_tokens where user_id = r.user_id) then
            insert into public.notification_deliveries (notification_id, channel) values (n_id, 'push');
        end if;

        update public.slot_reminders set status = 'sent', sent_at = now() where id = r.id;
    end loop;
    return processed;
end;
$$;

-- ------------------------------------------------------------
-- Listing requirements now include opening hours and priced courts
-- (same function as 002, with the extra checks)
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
revoke execute on function public.courts_guard_price() from public, anon, authenticated;
revoke execute on function public.assert_no_weekly_overlap(jsonb) from public, anon, authenticated;
revoke execute on function public.set_opening_hours(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.reset_court_hours(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.set_price_rules(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.court_price_per_hour(uuid, date, int) from public, anon, authenticated;
revoke execute on function public.get_availability(uuid, date, uuid) from public, anon, authenticated;
revoke execute on function public.claim_deliveries(int, int) from public, anon, authenticated;
revoke execute on function public.complete_delivery(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.create_slot_reminder(uuid, uuid, date, timestamptz) from public, anon, authenticated;
revoke execute on function public.venues_resync_reminders() from public, anon, authenticated;
revoke execute on function public.process_due_reminders(int) from public, anon, authenticated;
revoke execute on function public.transition_venue(uuid, text, uuid, text) from public, anon, authenticated;

grant execute on function public.assert_no_weekly_overlap(jsonb) to service_role;
grant execute on function public.set_opening_hours(uuid, uuid, jsonb) to service_role;
grant execute on function public.reset_court_hours(uuid, uuid) to service_role;
grant execute on function public.set_price_rules(uuid, uuid, jsonb) to service_role;
grant execute on function public.court_price_per_hour(uuid, date, int) to service_role;
grant execute on function public.get_availability(uuid, date, uuid) to service_role;
grant execute on function public.claim_deliveries(int, int) to service_role;
grant execute on function public.complete_delivery(uuid, text, text) to service_role;
grant execute on function public.create_slot_reminder(uuid, uuid, date, timestamptz) to service_role;
grant execute on function public.process_due_reminders(int) to service_role;
grant execute on function public.transition_venue(uuid, text, uuid, text) to service_role;

-- ------------------------------------------------------------
-- RLS: backend only (read-own for notifications)
-- ------------------------------------------------------------
alter table public.opening_hours enable row level security;
alter table public.price_rules enable row level security;
alter table public.court_blocks enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.push_tokens enable row level security;
alter table public.slot_reminders enable row level security;

create policy "Users can read own notifications"
    on public.notifications for select
    using (auth.uid() = user_id);
