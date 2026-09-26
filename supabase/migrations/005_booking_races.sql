-- ============================================================
-- Race-condition hardening for the booking hold window
--
-- 1. Payment grace: players see a 10-minute hold (expires_at), but the slot is only released
--    5 minutes later so a payment made in time is never lost to a late webhook.
-- 2. Idempotency re-checked after locks (concurrent duplicate requests return the same booking).
-- 3. Blocks lock the affected courts, so they can't slip past an in-flight booking.
-- 4. Bookings take a shared lock on the venue, so suspend/delete/unpublish can't miss them.
-- 5. One lock order everywhere: court -> venue -> profile (no deadlocks).
-- ============================================================

-- Slot is held until expires_at + grace
create or replace function public.hold_grace()
returns interval
language sql
immutable
as $$ select interval '5 minutes' $$;

create or replace function public.booking_is_active(p_status public.booking_status, p_expires_at timestamptz)
returns boolean
language sql
stable
as $$
    select p_status in ('confirmed', 'checked_in', 'completed', 'no_show')
        or (p_status = 'pending_payment' and p_expires_at + public.hold_grace() > now());
$$;

-- ------------------------------------------------------------
-- create_booking: lock order court -> venue (share) -> profile; idempotency re-check; grace-aware expiry
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
    v_venue_id uuid;
begin
    if p_idempotency_key is not null and p_user_id is not null then
        select * into existing from public.bookings where user_id = p_user_id and idempotency_key = p_idempotency_key;
        if existing.id is not null then
            return existing;
        end if;
    end if;

    -- 1) court: serializes bookings on this court
    select venue_id into v_venue_id from public.courts where id = p_court_id for update;
    if v_venue_id is null then
        raise exception 'Court not found' using errcode = 'P0002';
    end if;
    -- 2) venue (shared): waits for any in-flight suspend / delete / unpublish, and blocks them until we commit
    perform 1 from public.venues where id = v_venue_id for share;
    -- 3) player: serializes this player's holds and pay-at-venue bookings
    if p_user_id is not null then
        perform 1 from public.profiles where id = p_user_id for update;
    end if;

    -- A concurrent request with the same key may have finished while we waited for the locks
    if p_idempotency_key is not null and p_user_id is not null then
        select * into existing from public.bookings where user_id = p_user_id and idempotency_key = p_idempotency_key;
        if existing.id is not null then
            return existing;
        end if;
    end if;

    -- Release holds whose payment time and grace have both run out
    update public.bookings set status = 'expired'
     where court_id = p_court_id and status = 'pending_payment' and expires_at + public.hold_grace() <= now();

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
            select * into existing from public.bookings where user_id = p_user_id and idempotency_key = p_idempotency_key;
            if existing.id is not null then return existing; end if;
            raise;
    end;

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
-- Job: expire only after the grace period
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
         where status = 'pending_payment' and expires_at + public.hold_grace() <= now()
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
-- Blocks: lock the affected courts first (same order as bookings), then check
-- ------------------------------------------------------------
create or replace function public.court_blocks_guard_bookings()
returns trigger
language plpgsql
as $$
begin
    perform 1 from public.courts
     where venue_id = new.venue_id and (new.court_id is null or id = new.court_id)
     order by id
       for update;

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

-- ------------------------------------------------------------
-- Hours & pricing: court lock before venue lock (consistent order)
-- ------------------------------------------------------------
create or replace function public.set_opening_hours(p_venue_id uuid, p_court_id uuid, p_ranges jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
    v_status public.venue_status;
begin
    if p_court_id is not null then
        perform 1 from public.courts where id = p_court_id and venue_id = p_venue_id and deleted_at is null for update;
        if not found then
            raise exception 'Court not found' using errcode = 'P0002';
        end if;
    end if;

    select status into v_status from public.venues where id = p_venue_id and deleted_at is null for update;
    if v_status is null then
        raise exception 'Venue not found' using errcode = 'P0002';
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

create or replace function public.reset_court_hours(p_venue_id uuid, p_court_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
    update public.courts set uses_venue_hours = true
     where id = p_court_id and venue_id = p_venue_id and deleted_at is null;
    if not found then
        raise exception 'Court not found' using errcode = 'P0002';
    end if;
    perform 1 from public.venues where id = p_venue_id for update;
    delete from public.opening_hours where venue_id = p_venue_id and court_id = p_court_id;
end;
$$;

create or replace function public.set_price_rules(p_venue_id uuid, p_court_id uuid, p_rules jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
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

-- ------------------------------------------------------------
-- Privileges
-- ------------------------------------------------------------
revoke execute on function public.hold_grace() from public, anon, authenticated;
revoke execute on function public.booking_is_active(public.booking_status, timestamptz) from public, anon, authenticated;
revoke execute on function public.create_booking(uuid, uuid, uuid, date, timestamptz, int, text, int, int, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.process_booking_jobs(int) from public, anon, authenticated;
revoke execute on function public.court_blocks_guard_bookings() from public, anon, authenticated;
revoke execute on function public.set_opening_hours(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.reset_court_hours(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.set_price_rules(uuid, uuid, jsonb) from public, anon, authenticated;

grant execute on function public.hold_grace() to service_role;
grant execute on function public.booking_is_active(public.booking_status, timestamptz) to service_role;
grant execute on function public.create_booking(uuid, uuid, uuid, date, timestamptz, int, text, int, int, text, text, text, text) to service_role;
grant execute on function public.process_booking_jobs(int) to service_role;
grant execute on function public.set_opening_hours(uuid, uuid, jsonb) to service_role;
grant execute on function public.reset_court_hours(uuid, uuid) to service_role;
grant execute on function public.set_price_rules(uuid, uuid, jsonb) to service_role;
