-- ============================================================
-- Phase 1: sports, amenities, venues, courts, photos, search
-- ============================================================

create extension if not exists postgis with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ------------------------------------------------------------
-- SECURITY FIX: functions in public are callable by anon/authenticated
-- through the REST API by default. Only the backend (service_role) may call them.
-- ------------------------------------------------------------
revoke execute on function public.review_venue_owner(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.review_venue_owner(uuid, uuid, boolean, text) to service_role;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- Future functions in public are not executable by clients unless granted explicitly
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ------------------------------------------------------------
-- Reference data
-- ------------------------------------------------------------
create table public.sports (
    id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(id) <= 40),
    name text not null unique check (char_length(name) between 2 and 50),
    is_active boolean not null default true,
    sort_order int not null default 0,
    created_at timestamptz not null default now()
);

create table public.amenities (
    id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(id) <= 40),
    name text not null unique check (char_length(name) between 2 and 50),
    is_active boolean not null default true,
    sort_order int not null default 0,
    created_at timestamptz not null default now()
);

insert into public.sports (id, name, sort_order) values
    ('football', 'Football', 1),
    ('cricket', 'Cricket', 2),
    ('badminton', 'Badminton', 3),
    ('pickleball', 'Pickleball', 4),
    ('tennis', 'Tennis', 5),
    ('table-tennis', 'Table Tennis', 6),
    ('basketball', 'Basketball', 7),
    ('volleyball', 'Volleyball', 8),
    ('squash', 'Squash', 9),
    ('swimming', 'Swimming', 10);

insert into public.amenities (id, name, sort_order) values
    ('parking', 'Parking', 1),
    ('washroom', 'Washroom', 2),
    ('changing-room', 'Changing Room', 3),
    ('drinking-water', 'Drinking Water', 4),
    ('floodlights', 'Floodlights', 5),
    ('equipment-rental', 'Equipment Rental', 6),
    ('first-aid', 'First Aid', 7),
    ('seating', 'Seating Area', 8),
    ('cafeteria', 'Cafeteria', 9),
    ('shower', 'Shower', 10),
    ('locker', 'Locker', 11),
    ('wifi', 'Wi-Fi', 12);

-- ------------------------------------------------------------
-- Venues (extends the minimal table from 001)
-- ------------------------------------------------------------
create type public.venue_status as enum ('draft', 'pending_review', 'live', 'rejected', 'suspended');

alter table public.venues
    add column slug text unique,
    add column description text check (char_length(description) <= 2000),
    add column phone text,
    add column email text,
    add column address_line text check (char_length(address_line) <= 200),
    add column locality text check (char_length(locality) <= 100),
    add column city text check (char_length(city) <= 60),
    add column state text check (char_length(state) <= 60),
    add column pincode text check (pincode ~ '^[1-9][0-9]{5}$'),
    add column lat double precision check (lat between -90 and 90),
    add column lng double precision check (lng between -180 and 180),
    add column location extensions.geography(Point, 4326) generated always as (
        case when lat is not null and lng is not null
            then extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
        end
    ) stored,
    add column amenities text[] not null default '{}',
    add column rules text check (char_length(rules) <= 2000),
    add column timezone text not null default 'Asia/Kolkata',
    add column status public.venue_status not null default 'draft',
    add column status_reason text check (char_length(status_reason) <= 500),
    add column submitted_at timestamptz,
    add column reviewed_by uuid references public.profiles (id),
    add column reviewed_at timestamptz,
    add column deleted_at timestamptz,
    add constraint venues_name_len check (char_length(name) between 2 and 100),
    add constraint venues_latlng_pair check ((lat is null) = (lng is null));

create or replace function public.venue_set_slug()
returns trigger
language plpgsql
as $$
declare
    base text;
begin
    if new.slug is null then
        base := trim(both '-' from regexp_replace(lower(new.name || ' ' || coalesce(new.city, '')), '[^a-z0-9]+', '-', 'g'));
        if base = '' then base := 'venue'; end if;
        new.slug := left(base, 60) || '-' || substr(md5(gen_random_uuid()::text), 1, 6);
    end if;
    return new;
end;
$$;

create trigger venues_set_slug
    before insert on public.venues
    for each row execute function public.venue_set_slug();

-- A listed venue can never lose the fields it needs to be listed
create or replace function public.venues_guard_listed_fields()
returns trigger
language plpgsql
as $$
begin
    if new.status in ('live', 'pending_review') and new.deleted_at is null
       and (new.address_line is null or new.city is null or new.lat is null or new.phone is null) then
        raise exception 'A listed venue must keep its address, city, map location and phone' using errcode = 'P0001';
    end if;
    return new;
end;
$$;

create trigger venues_guard_listed_fields
    before update on public.venues
    for each row execute function public.venues_guard_listed_fields();

update public.venues set slug = 'venue-' || substr(md5(id::text), 1, 8) where slug is null;
alter table public.venues alter column slug set not null;

create index venues_live_location_idx on public.venues using gist (location)
    where status = 'live' and deleted_at is null;
create index venues_live_city_idx on public.venues (lower(city))
    where status = 'live' and deleted_at is null;
create index venues_name_trgm_idx on public.venues using gin (name extensions.gin_trgm_ops);
create index venues_locality_trgm_idx on public.venues using gin (locality extensions.gin_trgm_ops);
create index venues_amenities_idx on public.venues using gin (amenities);
create index venues_status_idx on public.venues (status) where deleted_at is null;

-- ------------------------------------------------------------
-- Courts: the bookable unit. A venue has many courts.
-- ------------------------------------------------------------
create table public.courts (
    id uuid primary key default gen_random_uuid(),
    venue_id uuid not null references public.venues (id) on delete cascade,
    name text not null check (char_length(name) between 1 and 60),
    sport_id text not null references public.sports (id),
    is_indoor boolean not null default false,
    surface text check (char_length(surface) <= 50),
    capacity int check (capacity between 1 and 100),
    base_slot_minutes int not null default 60 check (base_slot_minutes in (30, 60)),
    min_duration_minutes int not null default 60,
    max_duration_minutes int not null default 120,
    is_active boolean not null default true,
    sort_order int not null default 0,
    deleted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint courts_duration_check check (
        min_duration_minutes >= base_slot_minutes
        and min_duration_minutes % base_slot_minutes = 0
        and max_duration_minutes % base_slot_minutes = 0
        and max_duration_minutes >= min_duration_minutes
        and max_duration_minutes <= 720
    )
);

create unique index courts_venue_name_uidx on public.courts (venue_id, lower(name)) where deleted_at is null;
create index courts_venue_idx on public.courts (venue_id) where deleted_at is null;
create index courts_sport_active_idx on public.courts (sport_id, venue_id) where deleted_at is null and is_active;

create trigger courts_set_updated_at
    before update on public.courts
    for each row execute function public.set_updated_at();

-- A listed venue (live / pending review) must always keep at least one active court
create or replace function public.courts_guard_last_active()
returns trigger
language plpgsql
as $$
declare
    v_status public.venue_status;
begin
    if (old.is_active and old.deleted_at is null) and not (new.is_active and new.deleted_at is null) then
        select status into v_status from public.venues where id = old.venue_id for update;
        if v_status in ('live', 'pending_review') and not exists (
            select 1 from public.courts
             where venue_id = old.venue_id and id <> old.id and is_active and deleted_at is null
        ) then
            raise exception 'A listed venue must keep at least one active court' using errcode = 'P0001';
        end if;
    end if;
    return new;
end;
$$;

create trigger courts_guard_last_active
    before update on public.courts
    for each row execute function public.courts_guard_last_active();

-- ------------------------------------------------------------
-- Venue photos (files live in Cloudflare R2; storage_path is the object key)
-- ------------------------------------------------------------
create table public.venue_photos (
    id uuid primary key default gen_random_uuid(),
    venue_id uuid not null references public.venues (id) on delete cascade,
    storage_path text not null unique,
    is_cover boolean not null default false,
    sort_order int not null default 0,
    created_at timestamptz not null default now()
);

create unique index venue_photos_one_cover_idx on public.venue_photos (venue_id) where is_cover;
create index venue_photos_venue_idx on public.venue_photos (venue_id, sort_order);

-- Max 15 photos per venue; first photo becomes the cover; new photos go last
create or replace function public.venue_photos_before_insert()
returns trigger
language plpgsql
as $$
declare
    photo_count int;
begin
    perform 1 from public.venues where id = new.venue_id for update;
    select count(*) into photo_count from public.venue_photos where venue_id = new.venue_id;
    if photo_count >= 15 then
        raise exception 'A venue can have at most 15 photos' using errcode = 'P0001';
    end if;
    new.is_cover := photo_count = 0;
    new.sort_order := coalesce((select max(sort_order) + 1 from public.venue_photos where venue_id = new.venue_id), 0);
    return new;
end;
$$;

create trigger venue_photos_before_insert
    before insert on public.venue_photos
    for each row execute function public.venue_photos_before_insert();

-- Deletes a photo and returns its object key; promotes a new cover if needed
create or replace function public.delete_venue_photo(p_venue_id uuid, p_photo_id uuid)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
    v_status public.venue_status;
    deleted public.venue_photos;
begin
    select status into v_status from public.venues where id = p_venue_id for update;

    delete from public.venue_photos where id = p_photo_id and venue_id = p_venue_id returning * into deleted;
    if deleted.id is null then
        raise exception 'Photo not found' using errcode = 'P0002';
    end if;

    if v_status in ('live', 'pending_review') and not exists (select 1 from public.venue_photos where venue_id = p_venue_id) then
        raise exception 'A listed venue must keep at least one photo' using errcode = 'P0001';
    end if;

    if deleted.is_cover then
        update public.venue_photos set is_cover = true
         where id = (select id from public.venue_photos where venue_id = p_venue_id order by sort_order, created_at limit 1);
    end if;

    return deleted.storage_path;
end;
$$;

create or replace function public.set_venue_cover(p_venue_id uuid, p_photo_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
    perform 1 from public.venues where id = p_venue_id for update;
    if not exists (select 1 from public.venue_photos where id = p_photo_id and venue_id = p_venue_id) then
        raise exception 'Photo not found' using errcode = 'P0002';
    end if;
    update public.venue_photos set is_cover = false where venue_id = p_venue_id and is_cover and id <> p_photo_id;
    update public.venue_photos set is_cover = true where id = p_photo_id;
end;
$$;

-- p_photo_ids must list every photo of the venue exactly once, in the new order
create or replace function public.reorder_venue_photos(p_venue_id uuid, p_photo_ids uuid[])
returns void
language plpgsql
security definer set search_path = public
as $$
begin
    perform 1 from public.venues where id = p_venue_id for update;
    if (select count(distinct x) from unnest(p_photo_ids) x) <> cardinality(p_photo_ids)
       or cardinality(p_photo_ids) <> (select count(*) from public.venue_photos where venue_id = p_venue_id)
       or exists (select 1 from unnest(p_photo_ids) x where x not in (select id from public.venue_photos where venue_id = p_venue_id))
    then
        raise exception 'photo_ids must contain every photo of the venue exactly once' using errcode = 'P0001';
    end if;

    update public.venue_photos p
       set sort_order = o.ord
      from unnest(p_photo_ids) with ordinality as o (id, ord)
     where p.id = o.id;
end;
$$;

-- ------------------------------------------------------------
-- Venue status workflow
--   owner: submit (draft|rejected -> pending_review), unpublish (live|pending_review -> draft)
--   admin: approve (pending_review -> live), reject (pending_review -> rejected),
--          suspend (live|pending_review -> suspended), reinstate (suspended -> live)
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

    -- Anything going (back) to the public must be complete
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
-- Public search: live venues of active owners only
-- ------------------------------------------------------------
create or replace function public.search_venues(
    p_city text default null,
    p_sport text default null,
    p_q text default null,
    p_amenities text[] default null,
    p_lat double precision default null,
    p_lng double precision default null,
    p_radius_km double precision default null,
    p_sort text default 'name',
    p_limit int default 20,
    p_offset int default 0
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
        select v.id, v.slug, v.name, v.locality, v.city, v.lat, v.lng, v.amenities, v.created_at,
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
    ),
    page as (
        select m.*, count(*) over () as total_count
          from matches m
         order by
            case when p_sort = 'distance' then m.distance_km end asc nulls last,
            case when p_sort = 'newest' then m.created_at end desc,
            m.name asc,
            m.id
         limit p_limit offset p_offset
    )
    select pg.id, pg.slug, pg.name, pg.locality, pg.city, pg.lat, pg.lng, pg.amenities,
           coalesce((select array_agg(distinct c.sport_id order by c.sport_id) from public.courts c
                      where c.venue_id = pg.id and c.is_active and c.deleted_at is null), '{}') as sports,
           (select vp.storage_path from public.venue_photos vp where vp.venue_id = pg.id and vp.is_cover) as cover_path,
           pg.distance_km,
           pg.total_count
      from page pg
     order by
        case when p_sort = 'distance' then pg.distance_km end asc nulls last,
        case when p_sort = 'newest' then pg.created_at end desc,
        pg.name asc,
        pg.id;
$$;

-- Cities that currently have at least one live venue
create or replace function public.list_venue_cities()
returns table (city text, venue_count bigint)
language sql
stable
security definer set search_path = public
as $$
    select initcap(min(v.city)) as city, count(*) as venue_count
      from public.venues v
      join public.profiles p on p.id = v.owner_id
     where v.status = 'live' and v.deleted_at is null and v.city is not null
       and p.status = 'active' and p.role in ('venue_owner', 'admin')
     group by lower(v.city)
     order by count(*) desc, 1;
$$;

-- Backend only
revoke execute on function public.venue_set_slug() from public, anon, authenticated;
revoke execute on function public.venues_guard_listed_fields() from public, anon, authenticated;
revoke execute on function public.courts_guard_last_active() from public, anon, authenticated;
revoke execute on function public.venue_photos_before_insert() from public, anon, authenticated;
revoke execute on function public.delete_venue_photo(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.set_venue_cover(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.reorder_venue_photos(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.transition_venue(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.search_venues(text, text, text, text[], double precision, double precision, double precision, text, int, int) from public, anon, authenticated;
revoke execute on function public.list_venue_cities() from public, anon, authenticated;
grant execute on function public.delete_venue_photo(uuid, uuid) to service_role;
grant execute on function public.set_venue_cover(uuid, uuid) to service_role;
grant execute on function public.reorder_venue_photos(uuid, uuid[]) to service_role;
grant execute on function public.transition_venue(uuid, text, uuid, text) to service_role;
grant execute on function public.search_venues(text, text, text, text[], double precision, double precision, double precision, text, int, int) to service_role;
grant execute on function public.list_venue_cities() to service_role;

-- ------------------------------------------------------------
-- RLS (backend uses service role; reference data is public-read)
-- ------------------------------------------------------------
alter table public.sports enable row level security;
alter table public.amenities enable row level security;
alter table public.courts enable row level security;
alter table public.venue_photos enable row level security;

create policy "Anyone can read sports" on public.sports for select using (true);
create policy "Anyone can read amenities" on public.amenities for select using (true);
