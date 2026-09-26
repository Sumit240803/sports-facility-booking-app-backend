-- User profiles linked 1:1 to Supabase auth.users
create type public.user_role as enum ('player', 'venue_owner', 'admin');

create table public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    email text,
    phone text,
    full_name text,
    avatar_url text,
    city text,
    role public.user_role not null default 'player',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- The backend accesses profiles with the service role key; block direct client access
alter table public.profiles enable row level security;

create policy "Users can read own profile"
    on public.profiles for select
    using (auth.uid() = id);

-- Create a profile automatically whenever a user signs up (OAuth)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
    insert into public.profiles (id, email, phone, full_name, avatar_url)
    values (
        new.id,
        new.email,
        nullif(new.phone, ''),
        coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
        coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
