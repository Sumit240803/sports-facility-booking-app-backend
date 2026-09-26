-- ============================================================
-- Users: profiles, venue owner applications, venue staff
-- ============================================================

create type public.user_role as enum ('player', 'venue_owner', 'admin');
create type public.user_status as enum ('active', 'suspended');
create type public.owner_verification_status as enum ('pending', 'approved', 'rejected');
create type public.venue_staff_role as enum ('manager', 'staff');

-- Keeps updated_at current on every update
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

-- ------------------------------------------------------------
-- profiles: one row per auth user
-- ------------------------------------------------------------
create table public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    email text,
    full_name text,
    avatar_url text,
    phone text unique,
    phone_verified boolean not null default false,
    city text,
    preferred_sports text[] not null default '{}',
    role public.user_role not null default 'player',
    status public.user_status not null default 'active',
    onboarded_at timestamptz,
    last_login_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index profiles_email_idx on public.profiles (lower(email));

create trigger profiles_set_updated_at
    before update on public.profiles
    for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- venue_owner_details: owner application + business info
-- A user becomes role = 'venue_owner' only after admin approval
-- ------------------------------------------------------------
create table public.venue_owner_details (
    user_id uuid primary key references public.profiles (id) on delete cascade,
    business_name text not null,
    business_phone text not null,
    gstin text,
    payout_account jsonb, -- filled in later when payments are integrated
    verification_status public.owner_verification_status not null default 'pending',
    rejection_reason text,
    reviewed_by uuid references public.profiles (id),
    reviewed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index venue_owner_details_status_idx on public.venue_owner_details (verification_status);

create trigger venue_owner_details_set_updated_at
    before update on public.venue_owner_details
    for each row execute function public.set_updated_at();

-- Approve / reject atomically (status + role change in one transaction)
create or replace function public.review_venue_owner(
    p_user_id uuid,
    p_admin_id uuid,
    p_approve boolean,
    p_reason text default null
)
returns public.venue_owner_details
language plpgsql
security definer set search_path = public
as $$
declare
    result public.venue_owner_details;
begin
    update public.venue_owner_details
       set verification_status = case when p_approve then 'approved' else 'rejected' end::public.owner_verification_status,
           rejection_reason = case when p_approve then null else p_reason end,
           reviewed_by = p_admin_id,
           reviewed_at = now()
     where user_id = p_user_id
       and verification_status = 'pending'
    returning * into result;

    if result.user_id is null then
        raise exception 'No pending application for this user' using errcode = 'P0002';
    end if;

    if p_approve then
        update public.profiles set role = 'venue_owner' where id = p_user_id and role = 'player';
    end if;

    return result;
end;
$$;

-- ------------------------------------------------------------
-- venues (minimal for now, extended when venue features are built)
-- ------------------------------------------------------------
create table public.venues (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references public.profiles (id),
    name text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index venues_owner_idx on public.venues (owner_id);

create trigger venues_set_updated_at
    before update on public.venues
    for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- venue_staff: per-venue access for people who work at a venue
-- ------------------------------------------------------------
create table public.venue_staff (
    venue_id uuid not null references public.venues (id) on delete cascade,
    user_id uuid not null references public.profiles (id) on delete cascade,
    role public.venue_staff_role not null default 'staff',
    invited_by uuid references public.profiles (id),
    created_at timestamptz not null default now(),
    primary key (venue_id, user_id)
);

create index venue_staff_user_idx on public.venue_staff (user_id);

-- Invites for emails that have not signed up yet; claimed on first login
create table public.venue_staff_invites (
    venue_id uuid not null references public.venues (id) on delete cascade,
    email text not null,
    role public.venue_staff_role not null default 'staff',
    invited_by uuid references public.profiles (id),
    created_at timestamptz not null default now(),
    primary key (venue_id, email)
);

create index venue_staff_invites_email_idx on public.venue_staff_invites (email);

-- ------------------------------------------------------------
-- Sign-up trigger: create profile + claim pending staff invites
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
    insert into public.profiles (id, email, full_name, avatar_url)
    values (
        new.id,
        lower(new.email),
        coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
        coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
    )
    on conflict (id) do nothing;

    if new.email is not null then
        insert into public.venue_staff (venue_id, user_id, role, invited_by)
        select venue_id, new.id, role, invited_by
          from public.venue_staff_invites
         where email = lower(new.email)
        on conflict do nothing;

        delete from public.venue_staff_invites where email = lower(new.email);
    end if;

    return new;
end;
$$;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- RLS: the backend uses the service role key; clients get read-own only
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.venue_owner_details enable row level security;
alter table public.venues enable row level security;
alter table public.venue_staff enable row level security;
alter table public.venue_staff_invites enable row level security;

create policy "Users can read own profile"
    on public.profiles for select
    using (auth.uid() = id);

create policy "Users can read own owner application"
    on public.venue_owner_details for select
    using (auth.uid() = user_id);
