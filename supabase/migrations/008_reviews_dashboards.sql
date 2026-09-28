-- ============================================================
-- Phase 5: reviews & ratings, favourites, owner and admin dashboards
-- ============================================================

-- Razorpay: 2% + 18% GST = 2.36% of every captured payment (kept even when refunded), in basis points
create or replace function public.gateway_fee_bps()
returns int
language sql
immutable
as $$ select 236 $$;

-- ------------------------------------------------------------
-- Reviews: one per player per venue, only after playing there
-- ------------------------------------------------------------
create table public.reviews (
    id uuid primary key default gen_random_uuid(),
    venue_id uuid not null references public.venues (id) on delete cascade,
    user_id uuid not null references public.profiles (id) on delete cascade,
    booking_id uuid references public.bookings (id) on delete set null, -- the played booking that made them eligible
    rating smallint not null check (rating between 1 and 5),
    comment text check (char_length(comment) <= 1000),
    status text not null default 'visible' check (status in ('visible', 'hidden')),
    hidden_reason text check (char_length(hidden_reason) <= 500),
    owner_reply text check (char_length(owner_reply) between 1 and 1000),
    owner_replied_at timestamptz,
    owner_replied_by uuid references public.profiles (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, venue_id)
);

create index reviews_venue_idx on public.reviews (venue_id, status, created_at desc);

create trigger reviews_set_updated_at
    before update on public.reviews
    for each row execute function public.set_updated_at();

alter table public.venues
    add column rating_avg numeric(2, 1),
    add column rating_count int not null default 0;

-- Keep the venue's rating in sync with its visible reviews
create or replace function public.reviews_sync_venue_rating()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
    vid uuid := coalesce(new.venue_id, old.venue_id);
begin
    update public.venues v
       set rating_count = s.cnt, rating_avg = s.avg_rating
      from (select count(*)::int as cnt, round(avg(rating), 1) as avg_rating
              from public.reviews where venue_id = vid and status = 'visible') s
     where v.id = vid;
    return null;
end;
$$;

create trigger reviews_sync_venue_rating
    after insert or update of rating, status or delete on public.reviews
    for each row execute function public.reviews_sync_venue_rating();

-- Create or update the player's review of a venue
create or replace function public.submit_review(p_user_id uuid, p_venue_id uuid, p_rating int, p_comment text)
returns public.reviews
language plpgsql
security definer set search_path = public
as $$
declare
    played uuid;
    r public.reviews;
    is_new boolean;
    v public.venues;
begin
    select * into v from public.venues where id = p_venue_id and deleted_at is null;
    if v.id is null then
        raise exception 'Venue not found' using errcode = 'P0002';
    end if;

    select id into played from public.bookings
     where user_id = p_user_id and venue_id = p_venue_id
       and (status = 'completed' or (status = 'checked_in' and ends_at <= now()))
     order by ends_at desc
     limit 1;
    if played is null then
        raise exception 'You can review a venue after you have played there' using errcode = 'P0001';
    end if;

    is_new := not exists (select 1 from public.reviews where user_id = p_user_id and venue_id = p_venue_id);

    insert into public.reviews (venue_id, user_id, booking_id, rating, comment)
    values (p_venue_id, p_user_id, played, p_rating, nullif(trim(p_comment), ''))
    on conflict (user_id, venue_id) do update
        set rating = excluded.rating, comment = excluded.comment, booking_id = excluded.booking_id
    returning * into r;

    if is_new then
        perform public.notify_user(v.owner_id, 'new_review', format('New %s★ review', p_rating),
            format('%s got a %s-star review%s', v.name, p_rating,
                   case when r.comment is not null then ': "' || left(r.comment, 120) || '"' else '.' end),
            jsonb_build_object('venue_id', v.id, 'review_id', r.id));
    end if;
    return r;
end;
$$;

-- ------------------------------------------------------------
-- Favourites
-- ------------------------------------------------------------
create table public.favourites (
    user_id uuid not null references public.profiles (id) on delete cascade,
    venue_id uuid not null references public.venues (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (user_id, venue_id)
);

create index favourites_user_idx on public.favourites (user_id, created_at desc);

create or replace function public.favourites_limit()
returns trigger
language plpgsql
as $$
begin
    perform 1 from public.profiles where id = new.user_id for update;
    if (select count(*) from public.favourites where user_id = new.user_id) >= 200 then
        raise exception 'You can save at most 200 favourite venues' using errcode = 'P0001';
    end if;
    return new;
end;
$$;

create trigger favourites_limit
    before insert on public.favourites
    for each row execute function public.favourites_limit();

-- ------------------------------------------------------------
-- Search: ratings in results, min_rating filter, sort by rating
-- ------------------------------------------------------------
drop function public.search_venues(text, text, text, text[], double precision, double precision, double precision, text, int, int);

create function public.search_venues(
    p_city text default null,
    p_sport text default null,
    p_q text default null,
    p_amenities text[] default null,
    p_lat double precision default null,
    p_lng double precision default null,
    p_radius_km double precision default null,
    p_sort text default 'name',
    p_limit int default 20,
    p_offset int default 0,
    p_min_rating numeric default null
)
returns table (
    id uuid,
    slug text,
    name text,
    locality text,
    city text,
    lat double precision,
    lng double precision,
    amenities text[],
    sports text[],
    cover_path text,
    distance_km double precision,
    rating_avg numeric,
    rating_count int,
    total_count bigint
)
language sql
stable
security definer set search_path = public, extensions
as $$
    with origin as (
        select case when p_lat is not null and p_lng is not null
            then st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography end as g
    ),
    matches as (
        select v.id, v.slug, v.name, v.locality, v.city, v.lat, v.lng, v.amenities, v.created_at, v.rating_avg, v.rating_count,
               case when o.g is not null then st_distance(v.location, o.g) / 1000 end as distance_km
          from public.venues v
          join public.profiles p on p.id = v.owner_id
         cross join origin o
         where v.status = 'live'
           and v.deleted_at is null
           and p.status = 'active'
           and p.role in ('venue_owner', 'admin')
           and (p_city is null or lower(v.city) = lower(p_city))
           and (p_sport is null or exists (
                select 1 from public.courts c
                 where c.venue_id = v.id and c.sport_id = p_sport and c.is_active and c.deleted_at is null))
           and (p_q is null or v.name ilike '%' || p_q || '%' or v.locality ilike '%' || p_q || '%')
           and (p_amenities is null or v.amenities @> p_amenities)
           and (o.g is null or p_radius_km is null or st_dwithin(v.location, o.g, p_radius_km * 1000))
           and (p_min_rating is null or v.rating_avg >= p_min_rating)
    ),
    page as (
        select m.*, count(*) over () as total_count
          from matches m
         order by
            case when p_sort = 'distance' then m.distance_km end asc nulls last,
            case when p_sort = 'newest' then m.created_at end desc,
            case when p_sort = 'rating' then m.rating_avg end desc nulls last,
            case when p_sort = 'rating' then m.rating_count end desc,
            m.name asc,
            m.id
         limit p_limit offset p_offset
    )
    select pg.id, pg.slug, pg.name, pg.locality, pg.city, pg.lat, pg.lng, pg.amenities,
           coalesce((select array_agg(distinct c.sport_id order by c.sport_id) from public.courts c
                      where c.venue_id = pg.id and c.is_active and c.deleted_at is null), '{}') as sports,
           (select vp.storage_path from public.venue_photos vp where vp.venue_id = pg.id and vp.is_cover) as cover_path,
           pg.distance_km,
           pg.rating_avg,
           pg.rating_count,
           pg.total_count
      from page pg
     order by
        case when p_sort = 'distance' then pg.distance_km end asc nulls last,
        case when p_sort = 'newest' then pg.created_at end desc,
        case when p_sort = 'rating' then pg.rating_avg end desc nulls last,
        case when p_sort = 'rating' then pg.rating_count end desc,
        pg.name asc,
        pg.id;
$$;

-- ------------------------------------------------------------
-- Platform revenue of one booking before gateway fees (paise); null while not final
--   online paid: what the platform kept (paid - refunded) minus what the venue is credited
--   pay-at-venue completed: the commission the venue owes
-- ------------------------------------------------------------
create or replace function public.booking_platform_revenue(b public.bookings)
returns int
language sql
immutable
as $$
    select case
        when b.payment_method = 'online' and b.payment_status = 'paid' and b.status in ('completed', 'no_show', 'cancelled')
            then b.total_paise - coalesce(b.refund_paise, 0) - public.booking_venue_net(b)
        when b.payment_method = 'pay_at_venue' and b.status = 'completed'
            then -public.booking_venue_net(b)
        when b.status in ('completed', 'no_show', 'cancelled', 'expired') then 0
        else null
    end;
$$;

-- Platform commission on one booking (paise), same basis as the venue ledger
create or replace function public.booking_commission(b public.bookings)
returns int
language sql
immutable
as $$
    select case
        when b.payment_method = 'pay_at_venue' and b.status = 'completed'
            then round(b.subtotal_paise * b.commission_percent / 100.0)::int
        when b.payment_method = 'online' and b.payment_status = 'paid' and b.status in ('completed', 'no_show')
            then round(b.subtotal_paise * b.commission_percent / 100.0)::int
        when b.payment_method = 'online' and b.payment_status = 'paid' and b.status = 'cancelled'
            then round(round(b.subtotal_paise * (100 - coalesce(b.refund_percent, 0)) / 100.0) * b.commission_percent / 100.0)::int
        else 0
    end;
$$;

-- ------------------------------------------------------------
-- Owner dashboard for a venue over local dates [p_from, p_to]
-- ------------------------------------------------------------
create or replace function public.venue_dashboard(p_venue_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer set search_path = public
as $$
declare
    tz text;
    t0 timestamptz;
    t1 timestamptz;
    result jsonb;
begin
    select timezone into tz from public.venues where id = p_venue_id;
    if tz is null then
        raise exception 'Venue not found' using errcode = 'P0002';
    end if;
    t0 := p_from::timestamp at time zone tz;
    t1 := (p_to + 1)::timestamp at time zone tz;

    with b as (
        select bk.*, (bk.starts_at at time zone tz) as local_start
          from public.bookings bk
         where bk.venue_id = p_venue_id and bk.starts_at >= t0 and bk.starts_at < t1 and bk.status <> 'expired'
    ),
    held as (select * from b where status in ('confirmed', 'checked_in', 'completed', 'no_show')),
    days as (select d::date as d from generate_series(p_from, p_to, interval '1 day') d),
    court_list as (
        select id, name, uses_venue_hours, sort_order from public.courts
         where venue_id = p_venue_id and deleted_at is null
    ),
    open_minutes as (
        select c.id as court_id, coalesce(sum(h.end_minute - h.start_minute), 0) as minutes
          from court_list c
          cross join days
          join public.opening_hours h
            on h.venue_id = p_venue_id and h.day_of_week = extract(dow from days.d)::smallint
           and ((c.uses_venue_hours and h.court_id is null) or (not c.uses_venue_hours and h.court_id = c.id))
         group by c.id
    ),
    occupancy as (
        select c.id, c.name, c.sort_order,
               coalesce((select sum(duration_minutes) from held where held.court_id = c.id), 0) as booked_minutes,
               coalesce(om.minutes, 0) as open_minutes
          from court_list c left join open_minutes om on om.court_id = c.id
    )
    select jsonb_build_object(
        'from', p_from, 'to', p_to, 'timezone', tz,
        'bookings', jsonb_build_object(
            'total', (select count(*) from b),
            'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from b group by status) s), '{}'),
            'by_method', coalesce((select jsonb_object_agg(payment_method, n) from (select payment_method, count(*) n from b group by payment_method) s), '{}'),
            'cancellation_rate_percent', (select round(100.0 * count(*) filter (where status = 'cancelled') / nullif(count(*), 0), 1) from b),
            'no_show_rate_percent', (select round(100.0 * count(*) filter (where status = 'no_show') / nullif(count(*) filter (where status in ('completed', 'checked_in', 'no_show')), 0), 1) from b)
        ),
        'money', jsonb_build_object(
            'booked_value_paise', (select coalesce(sum(subtotal_paise), 0) from held),
            'online_received_paise', (select coalesce(sum(total_paise - coalesce(refund_paise, 0)), 0) from b where payment_method = 'online' and payment_status = 'paid'),
            'collected_at_venue_paise', (select coalesce(sum(collected_paise), 0) from b),
            'refunded_paise', (select coalesce(sum(refund_paise), 0) from b where refund_status <> 'none'),
            'venue_earnings_paise', (select coalesce(sum(l.amount_paise), 0) from public.venue_ledger l join b on b.id = l.booking_id),
            'commission_paise', (select coalesce(sum(public.booking_commission(bk2)), 0)
                                   from public.bookings bk2 join b on b.id = bk2.id),
            'balance_paise', public.venue_balance(p_venue_id)
        ),
        'courts', coalesce((select jsonb_agg(jsonb_build_object(
                'court_id', id, 'name', name, 'booked_minutes', booked_minutes, 'open_minutes', open_minutes,
                'occupancy_percent', case when open_minutes > 0 then round(100.0 * booked_minutes / open_minutes, 1) else null end
            ) order by sort_order, name) from occupancy), '[]'),
        'daily', coalesce((select jsonb_agg(jsonb_build_object(
                'date', days.d,
                'bookings', (select count(*) from held where local_start::date = days.d),
                'booked_value_paise', (select coalesce(sum(subtotal_paise), 0) from held where local_start::date = days.d)
            ) order by days.d) from days), '[]'),
        'peak_hours', coalesce((select jsonb_agg(jsonb_build_object('day', dow, 'hour', hr, 'bookings', n) order by dow, hr)
              from (select extract(dow from local_start)::int dow, extract(hour from local_start)::int hr, count(*) n
                      from held group by 1, 2) ph), '[]'),
        'ratings', jsonb_build_object(
            'average', (select rating_avg from public.venues where id = p_venue_id),
            'count', (select rating_count from public.venues where id = p_venue_id),
            'breakdown', (select jsonb_build_object('1', count(*) filter (where rating = 1), '2', count(*) filter (where rating = 2),
                                                    '3', count(*) filter (where rating = 3), '4', count(*) filter (where rating = 4),
                                                    '5', count(*) filter (where rating = 5))
                            from public.reviews where venue_id = p_venue_id and status = 'visible')
        ),
        'today', jsonb_build_object(
            'upcoming_bookings', (select count(*) from public.bookings
                                   where venue_id = p_venue_id and status in ('confirmed', 'checked_in', 'pending_payment')
                                     and starts_at >= now() and (starts_at at time zone tz)::date = (now() at time zone tz)::date)
        )
    ) into result;
    return result;
end;
$$;

-- ------------------------------------------------------------
-- Admin dashboard over Asia/Kolkata dates [p_from, p_to]
-- ------------------------------------------------------------
create or replace function public.admin_dashboard(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer set search_path = public
as $$
declare
    tz constant text := 'Asia/Kolkata';
    t0 timestamptz := p_from::timestamp at time zone tz;
    t1 timestamptz := (p_to + 1)::timestamp at time zone tz;
    result jsonb;
begin
    with b as (
        select * from public.bookings where starts_at >= t0 and starts_at < t1 and status <> 'expired'
    ),
    held as (select * from b where status in ('confirmed', 'checked_in', 'completed', 'no_show')),
    captured as (
        select coalesce(sum(amount_paise), 0) as amount, count(*) as n
          from public.payments where status = 'captured' and captured_at >= t0 and captured_at < t1
    ),
    revenue as (
        select coalesce(sum(public.booking_platform_revenue(b)), 0) as gross,
               coalesce(sum(case when payment_method = 'online' and payment_status = 'paid' then discount_paise else 0 end), 0) as discounts
          from b
    )
    select jsonb_build_object(
        'from', p_from, 'to', p_to, 'timezone', tz,
        'bookings', jsonb_build_object(
            'total', (select count(*) from b),
            'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from b group by status) s), '{}'),
            'by_method', coalesce((select jsonb_object_agg(payment_method, n) from (select payment_method, count(*) n from b group by payment_method) s), '{}')
        ),
        'money', jsonb_build_object(
            'gross_booking_value_paise', (select coalesce(sum(subtotal_paise), 0) from held),
            'online_captured_paise', (select amount from captured),
            'online_payments', (select n from captured),
            'refunds_paise', (select coalesce(sum(amount_paise), 0) from public.refunds where created_at >= t0 and created_at < t1),
            'discounts_given_paise', (select discounts from revenue),
            'platform_revenue_before_fees_paise', (select gross from revenue),
            'gateway_fees_paise', (select round(amount * public.gateway_fee_bps() / 10000.0)::int from captured),
            'platform_net_paise', (select gross from revenue) - (select round(amount * public.gateway_fee_bps() / 10000.0)::int from captured),
            'owed_to_venues_paise', (select coalesce(sum(amount_paise), 0) from public.venue_ledger)
        ),
        'venues', jsonb_build_object(
            'live', (select count(*) from public.venues where status = 'live' and deleted_at is null),
            'pending_review', (select count(*) from public.venues where status = 'pending_review' and deleted_at is null),
            'suspended', (select count(*) from public.venues where status = 'suspended' and deleted_at is null),
            'pending_owner_applications', (select count(*) from public.venue_owner_details where verification_status = 'pending')
        ),
        'users', jsonb_build_object(
            'total', (select count(*) from public.profiles),
            'new_in_period', (select count(*) from public.profiles where created_at >= t0 and created_at < t1),
            'active_players', (select count(distinct user_id) from b where user_id is not null)
        ),
        'attention', jsonb_build_object(
            'failed_refunds', (select count(*) from public.refunds where status = 'failed'),
            'stuck_payouts', (select count(*) from public.payouts where status = 'processing' and created_at < now() - interval '1 hour'),
            'failed_notifications', (select count(*) from public.notification_deliveries where status = 'failed')
        ),
        'top_venues', coalesce((select jsonb_agg(t order by (t ->> 'booked_value_paise')::bigint desc) from (
            select jsonb_build_object('venue_id', v.id, 'name', v.name, 'city', v.city,
                                      'bookings', count(*), 'booked_value_paise', sum(h.subtotal_paise)) as t
              from held h join public.venues v on v.id = h.venue_id
             group by v.id, v.name, v.city
             order by sum(h.subtotal_paise) desc
             limit 10) top), '[]')
    ) into result;
    return result;
end;
$$;

-- ------------------------------------------------------------
-- Privileges & RLS
-- ------------------------------------------------------------
revoke execute on function public.gateway_fee_bps() from public, anon, authenticated;
revoke execute on function public.reviews_sync_venue_rating() from public, anon, authenticated;
revoke execute on function public.submit_review(uuid, uuid, int, text) from public, anon, authenticated;
revoke execute on function public.favourites_limit() from public, anon, authenticated;
revoke execute on function public.search_venues(text, text, text, text[], double precision, double precision, double precision, text, int, int, numeric) from public, anon, authenticated;
revoke execute on function public.booking_platform_revenue(public.bookings) from public, anon, authenticated;
revoke execute on function public.booking_commission(public.bookings) from public, anon, authenticated;
revoke execute on function public.venue_dashboard(uuid, date, date) from public, anon, authenticated;
revoke execute on function public.admin_dashboard(date, date) from public, anon, authenticated;

grant execute on function public.gateway_fee_bps() to service_role;
grant execute on function public.submit_review(uuid, uuid, int, text) to service_role;
grant execute on function public.search_venues(text, text, text, text[], double precision, double precision, double precision, text, int, int, numeric) to service_role;
grant execute on function public.booking_platform_revenue(public.bookings) to service_role;
grant execute on function public.booking_commission(public.bookings) to service_role;
grant execute on function public.venue_dashboard(uuid, date, date) to service_role;
grant execute on function public.admin_dashboard(date, date) to service_role;

alter table public.reviews enable row level security;
alter table public.favourites enable row level security;

create policy "Anyone can read visible reviews" on public.reviews for select using (status = 'visible');
create policy "Users can read own favourites" on public.favourites for select using (auth.uid() = user_id);
