-- ============================================================
-- Phase 4: payments (Razorpay), refunds, venue ledger and payouts
--
-- Money model (all paise):
--   online:       player pays total = subtotal - 10% (platform-funded discount);
--                 venue earns subtotal - commission, credited when the booking is final
--   pay_at_venue: venue collects subtotal at the venue; platform commission is debited from its balance
--   offline:      walk-ins, no commission
-- ============================================================

create or replace function public.platform_commission_percent()
returns int
language sql
immutable
as $$ select 10 $$;

-- ------------------------------------------------------------
-- Payments (one row per Razorpay order; extra captured payments on the same order get their own row)
-- ------------------------------------------------------------
create type public.gateway_payment_status as enum ('created', 'authorized', 'captured', 'failed');

create table public.payments (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null references public.bookings (id),
    user_id uuid references public.profiles (id) on delete set null,
    razorpay_order_id text not null,
    razorpay_payment_id text unique,
    amount_paise int not null check (amount_paise > 0),
    currency text not null default 'INR',
    status public.gateway_payment_status not null default 'created',
    method text,
    error_code text,
    error_description text,
    captured_at timestamptz,
    last_checked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index payments_booking_idx on public.payments (booking_id);
create index payments_order_idx on public.payments (razorpay_order_id);
create index payments_open_idx on public.payments (created_at) where status in ('created', 'authorized');

create trigger payments_set_updated_at
    before update on public.payments
    for each row execute function public.set_updated_at();

alter table public.bookings
    add column commission_percent smallint not null default 0 check (commission_percent between 0 and 100),
    add column payment_id uuid references public.payments (id);

-- Commission is fixed on the booking when it is made
create or replace function public.bookings_set_commission()
returns trigger
language plpgsql
as $$
begin
    new.commission_percent := case when new.payment_method in ('online', 'pay_at_venue')
                                   then public.platform_commission_percent() else 0 end;
    return new;
end;
$$;

create trigger bookings_set_commission
    before insert on public.bookings
    for each row execute function public.bookings_set_commission();

-- ------------------------------------------------------------
-- Refunds: at most one per payment
-- ------------------------------------------------------------
create type public.refund_state as enum ('pending', 'processing', 'processed', 'failed');

create table public.refunds (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null references public.bookings (id),
    payment_id uuid not null unique references public.payments (id),
    amount_paise int not null check (amount_paise > 0),
    reason text not null check (reason in ('booking_cancelled', 'slot_unavailable', 'duplicate_payment', 'amount_mismatch', 'booking_started')),
    status public.refund_state not null default 'pending',
    razorpay_refund_id text unique,
    attempts int not null default 0,
    next_attempt_at timestamptz not null default now(),
    locked_until timestamptz,
    last_error text,
    created_at timestamptz not null default now(),
    processed_at timestamptz
);

create index refunds_due_idx on public.refunds (next_attempt_at) where status in ('pending', 'processing');

-- Webhook de-duplication (Razorpay retries deliveries)
create table public.webhook_events (
    id text primary key,
    event text not null,
    received_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Payout settings, ledger, payouts
-- ------------------------------------------------------------
create type public.payout_mode as enum ('manual', 'route');
create type public.payout_status as enum ('processing', 'paid', 'failed');

create table public.venue_payout_settings (
    venue_id uuid primary key references public.venues (id) on delete cascade,
    mode public.payout_mode not null default 'manual',
    razorpay_account_id text check (razorpay_account_id ~ '^acc_[A-Za-z0-9]{6,32}$'),
    account_holder_name text check (char_length(account_holder_name) between 2 and 100),
    bank_account_number text check (bank_account_number ~ '^[0-9]{9,18}$'),
    bank_ifsc text check (bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
    upi_id text check (upi_id ~ '^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,64}$'),
    updated_by uuid references public.profiles (id) on delete set null,
    updated_at timestamptz not null default now(),
    constraint payout_route_needs_account check (mode <> 'route' or razorpay_account_id is not null)
);

create table public.payouts (
    id uuid primary key default gen_random_uuid(),
    venue_id uuid not null references public.venues (id),
    amount_paise int not null check (amount_paise > 0),
    mode public.payout_mode not null,
    status public.payout_status not null,
    razorpay_transfer_id text unique,
    reference text check (char_length(reference) <= 100),
    note text check (char_length(note) <= 500),
    failed_reason text,
    created_by uuid references public.profiles (id) on delete set null,
    created_at timestamptz not null default now(),
    paid_at timestamptz
);

create index payouts_venue_idx on public.payouts (venue_id, created_at desc);
create unique index payouts_one_processing_idx on public.payouts (venue_id) where status = 'processing';

create table public.venue_ledger (
    id uuid primary key default gen_random_uuid(),
    venue_id uuid not null references public.venues (id),
    booking_id uuid unique references public.bookings (id),
    payout_id uuid references public.payouts (id),
    entry_type text not null check (entry_type in ('booking', 'payout', 'payout_reversal', 'adjustment')),
    amount_paise int not null,
    description text,
    created_by uuid references public.profiles (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index venue_ledger_venue_idx on public.venue_ledger (venue_id, created_at desc);

create trigger venue_ledger_set_updated_at
    before update on public.venue_ledger
    for each row execute function public.set_updated_at();

-- Venue's net effect of one booking (credit positive, debit negative)
create or replace function public.booking_venue_net(b public.bookings)
returns int
language plpgsql
immutable
as $$
declare
    gross int;
begin
    if b.payment_method = 'online' and b.payment_status = 'paid' then
        gross := case
            when b.status in ('completed', 'no_show') then b.subtotal_paise
            when b.status = 'cancelled' then round(b.subtotal_paise * (100 - coalesce(b.refund_percent, 0)) / 100.0)::int
            else 0
        end;
        return gross - round(gross * b.commission_percent / 100.0)::int;
    elsif b.payment_method = 'pay_at_venue' and b.status = 'completed' then
        return -round(b.subtotal_paise * b.commission_percent / 100.0)::int;
    end if;
    return 0;
end;
$$;

-- Keeps one ledger row per booking in sync with its final state (re-computed on every change)
create or replace function public.bookings_sync_ledger()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
    net int;
begin
    if new.status is not distinct from old.status and new.payment_status is not distinct from old.payment_status
       and new.refund_percent is not distinct from old.refund_percent then
        return new;
    end if;
    net := public.booking_venue_net(new);
    if net = 0 and not exists (select 1 from public.venue_ledger where booking_id = new.id) then
        return new;
    end if;
    insert into public.venue_ledger (venue_id, booking_id, entry_type, amount_paise, description)
    values (new.venue_id, new.id, 'booking', net,
            case when net >= 0 then format('Booking %s', new.reference) else format('Commission on pay-at-venue booking %s', new.reference) end)
    on conflict (booking_id) do update set amount_paise = excluded.amount_paise, description = excluded.description;
    return new;
end;
$$;

create trigger bookings_sync_ledger
    after update on public.bookings
    for each row execute function public.bookings_sync_ledger();

create or replace function public.venue_balance(p_venue_id uuid)
returns int
language sql
stable
security definer set search_path = public
as $$
    select coalesce(sum(amount_paise), 0)::int from public.venue_ledger where venue_id = p_venue_id;
$$;

-- All venues with a non-zero balance, largest first
create or replace function public.list_venue_balances()
returns table (venue_id uuid, venue_name text, venue_slug text, city text, payout_mode public.payout_mode, balance_paise bigint)
language sql
stable
security definer set search_path = public
as $$
    select l.venue_id, v.name, v.slug, v.city, coalesce(s.mode, 'manual'), sum(l.amount_paise)
      from public.venue_ledger l
      join public.venues v on v.id = l.venue_id
      left join public.venue_payout_settings s on s.venue_id = l.venue_id
     group by l.venue_id, v.name, v.slug, v.city, s.mode
    having sum(l.amount_paise) <> 0
     order by sum(l.amount_paise) desc;
$$;

-- ------------------------------------------------------------
-- Payment capture: confirms the booking, or queues an automatic refund
-- p_outcome in result: confirmed | already_processed | refund_queued | unknown_order
-- ------------------------------------------------------------
create or replace function public.record_payment_captured(
    p_order_id text,
    p_payment_id text,
    p_amount int,
    p_currency text,
    p_method text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
    p public.payments;
    b public.bookings;
    refund_reason text;
begin
    -- Same payment seen before (verify call + webhook, or webhook retry)
    select * into p from public.payments where razorpay_payment_id = p_payment_id for update;
    if p.id is not null and p.status = 'captured' then
        return jsonb_build_object('outcome', 'already_processed', 'booking_id', p.booking_id);
    end if;

    if p.id is null then
        select * into p from public.payments
         where razorpay_order_id = p_order_id and razorpay_payment_id is null
         order by created_at limit 1
         for update;
    end if;
    if p.id is null then
        -- Another payment on an order we know about (customer paid twice on one order)
        select * into p from public.payments where razorpay_order_id = p_order_id order by created_at limit 1;
        if p.id is null then
            return jsonb_build_object('outcome', 'unknown_order');
        end if;
        insert into public.payments (booking_id, user_id, razorpay_order_id, razorpay_payment_id, amount_paise, currency, status, method, captured_at)
        values (p.booking_id, p.user_id, p_order_id, p_payment_id, p_amount, p_currency, 'captured', p_method, now())
        returning * into p;
    else
        update public.payments
           set razorpay_payment_id = p_payment_id, status = 'captured', method = p_method,
               amount_paise = p_amount, currency = p_currency, captured_at = now(), error_code = null, error_description = null
         where id = p.id
        returning * into p;
    end if;

    select * into b from public.bookings where id = p.booking_id for update;

    if p_amount <> b.total_paise or p_currency <> 'INR' then
        refund_reason := 'amount_mismatch';
    elsif b.payment_status = 'paid' then
        refund_reason := 'duplicate_payment';
    elsif b.status = 'cancelled' then
        refund_reason := 'booking_cancelled';
    elsif b.status not in ('pending_payment', 'expired') then
        refund_reason := 'duplicate_payment';
    elsif b.starts_at <= now() then
        refund_reason := 'booking_started';
    elsif not public.booking_is_active(b.status, b.expires_at) and (
        -- Reviving a lapsed hold: blocks, deactivation and suspension ignore lapsed holds, so re-check them
        not exists (
            select 1 from public.courts c join public.venues v on v.id = c.venue_id
             where c.id = b.court_id and c.is_active and c.deleted_at is null
               and v.status = 'live' and v.deleted_at is null
        )
        or exists (
            select 1 from public.court_blocks cb
             where cb.venue_id = b.venue_id and (cb.court_id is null or cb.court_id = b.court_id)
               and cb.starts_at < b.ends_at and cb.ends_at > b.starts_at
        )
    ) then
        refund_reason := 'slot_unavailable';
    else
        -- Confirm; an expired hold is revived if nobody took the slot meanwhile
        begin
            update public.bookings
               set status = 'confirmed', payment_status = 'paid', payment_id = p.id, expires_at = null
             where id = b.id
            returning * into b;
        exception when exclusion_violation then
            refund_reason := 'slot_unavailable';
        end;
    end if;

    if refund_reason is not null then
        insert into public.refunds (booking_id, payment_id, amount_paise, reason)
        values (b.id, p.id, p_amount, refund_reason)
        on conflict (payment_id) do nothing;
        perform public.notify_user(b.user_id, 'payment_refunded', 'Payment will be refunded',
            format('We could not use your payment of ₹%s for %s (%s). A full refund is on its way (5-7 working days).',
                   to_char(p_amount / 100.0, 'FM999999990.00'), public.booking_notification_text(b),
                   case refund_reason
                       when 'slot_unavailable' then 'the slot was taken after your payment window ended'
                       when 'booking_cancelled' then 'the booking was cancelled'
                       when 'duplicate_payment' then 'this booking was already paid'
                       when 'booking_started' then 'the booking had already started'
                       else 'the amount did not match' end),
            jsonb_build_object('booking_id', b.id, 'reference', b.reference));
        return jsonb_build_object('outcome', 'refund_queued', 'reason', refund_reason, 'booking_id', b.id);
    end if;

    perform public.notify_user(b.user_id, 'booking_confirmed', 'Booking confirmed',
        format('%s is confirmed. Ref %s. Paid ₹%s online.', public.booking_notification_text(b), b.reference,
               to_char(b.total_paise / 100.0, 'FM999999990.00')),
        jsonb_build_object('booking_id', b.id, 'reference', b.reference));
    return jsonb_build_object('outcome', 'confirmed', 'booking_id', b.id);
end;
$$;

create or replace function public.record_payment_failed(p_order_id text, p_payment_id text, p_code text, p_description text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
    update public.payments
       set status = 'failed', razorpay_payment_id = coalesce(razorpay_payment_id, p_payment_id),
           error_code = left(p_code, 100), error_description = left(p_description, 500)
     where razorpay_order_id = p_order_id and status in ('created', 'authorized')
       and (razorpay_payment_id is null or razorpay_payment_id = p_payment_id);
end;
$$;

-- ------------------------------------------------------------
-- Cancellation refunds (Phase 3 sets refund_status = 'pending') become refund rows
-- ------------------------------------------------------------
create or replace function public.bookings_queue_refund()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
    if new.refund_status = 'pending' and old.refund_status is distinct from 'pending'
       and new.refund_paise > 0 and new.payment_id is not null then
        insert into public.refunds (booking_id, payment_id, amount_paise, reason)
        values (new.id, new.payment_id, new.refund_paise, 'booking_cancelled')
        on conflict (payment_id) do nothing;
    end if;
    return new;
end;
$$;

create trigger bookings_queue_refund
    after update on public.bookings
    for each row execute function public.bookings_queue_refund();

-- Refund outbox, same leasing pattern as notification deliveries
create or replace function public.claim_refunds(p_limit int, p_lease_seconds int)
returns table (id uuid, booking_id uuid, amount_paise int, attempts int, razorpay_payment_id text, razorpay_refund_id text)
language plpgsql
security definer set search_path = public
as $$
begin
    return query
    with due as (
        select r.id from public.refunds r
         where (r.status = 'pending' and r.next_attempt_at <= now())
            or (r.status = 'processing' and r.razorpay_refund_id is null and r.locked_until < now())
         order by r.next_attempt_at
         limit p_limit
         for update skip locked
    ),
    claimed as (
        update public.refunds r
           set status = 'processing', attempts = r.attempts + 1,
               locked_until = now() + make_interval(secs => p_lease_seconds)
          from due where r.id = due.id
        returning r.id, r.booking_id, r.amount_paise, r.attempts, r.payment_id, r.razorpay_refund_id
    )
    select c.id, c.booking_id, c.amount_paise, c.attempts, p.razorpay_payment_id, c.razorpay_refund_id
      from claimed c join public.payments p on p.id = c.payment_id;
end;
$$;

-- p_state: processing (created at Razorpay) | processed | failed (permanent) | retry
create or replace function public.update_refund(p_id uuid, p_state text, p_razorpay_refund_id text default null, p_error text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
    r public.refunds;
begin
    update public.refunds
       set razorpay_refund_id = coalesce(p_razorpay_refund_id, razorpay_refund_id),
           status = case
               when p_state = 'processed' then 'processed'
               when p_state = 'processing' then 'processing'
               when p_state = 'failed' or attempts >= 5 then 'failed'
               else 'pending'
           end::public.refund_state,
           processed_at = case when p_state = 'processed' then now() else processed_at end,
           next_attempt_at = case when p_state = 'retry' then now() + make_interval(secs => 60 * power(2, attempts)::int) else next_attempt_at end,
           locked_until = null,
           last_error = case when p_error is not null then left(p_error, 500) else last_error end
     where id = p_id
    returning * into r;

    -- Mirror onto the booking for cancellation refunds
    if r.reason = 'booking_cancelled' then
        update public.bookings
           set refund_status = case r.status when 'processed' then 'processed' when 'failed' then 'failed' else 'pending' end::public.refund_status
         where id = r.booking_id and payment_id = r.payment_id;
    end if;
end;
$$;

-- Refund webhooks identify the refund by Razorpay's id
create or replace function public.update_refund_by_gateway_id(p_razorpay_refund_id text, p_state text, p_error text default null)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
    rid uuid;
begin
    select id into rid from public.refunds where razorpay_refund_id = p_razorpay_refund_id for update;
    if rid is null then return false; end if;
    perform public.update_refund(rid, p_state, null, p_error);
    return true;
end;
$$;

-- ------------------------------------------------------------
-- Payouts
-- ------------------------------------------------------------

-- Manual payout recorded by an admin after sending a bank/UPI transfer
create or replace function public.record_manual_payout(p_venue_id uuid, p_amount int, p_reference text, p_note text, p_admin_id uuid)
returns public.payouts
language plpgsql
security definer set search_path = public
as $$
declare
    po public.payouts;
begin
    perform 1 from public.venues where id = p_venue_id for update;
    if not found then
        raise exception 'Venue not found' using errcode = 'P0002';
    end if;
    if p_amount > public.venue_balance(p_venue_id) then
        raise exception 'Payout exceeds the venue balance of ₹%', to_char(public.venue_balance(p_venue_id) / 100.0, 'FM999999990.00') using errcode = 'P0001';
    end if;
    insert into public.payouts (venue_id, amount_paise, mode, status, reference, note, created_by, paid_at)
    values (p_venue_id, p_amount, 'manual', 'paid', p_reference, p_note, p_admin_id, now())
    returning * into po;
    insert into public.venue_ledger (venue_id, payout_id, entry_type, amount_paise, description, created_by)
    values (p_venue_id, po.id, 'payout', -p_amount, format('Payout %s', coalesce(p_reference, '')), p_admin_id);
    return po;
end;
$$;

-- Starts an automatic Route payout of the whole balance (the job then calls Razorpay)
create or replace function public.start_route_payout(p_venue_id uuid, p_min_amount int)
returns public.payouts
language plpgsql
security definer set search_path = public
as $$
declare
    po public.payouts;
    bal int;
begin
    perform 1 from public.venues where id = p_venue_id for update;
    bal := public.venue_balance(p_venue_id);
    if bal < p_min_amount or exists (select 1 from public.payouts where venue_id = p_venue_id and status = 'processing') then
        return null;
    end if;
    insert into public.payouts (venue_id, amount_paise, mode, status, note)
    values (p_venue_id, bal, 'route', 'processing', 'Automatic Route transfer')
    returning * into po;
    insert into public.venue_ledger (venue_id, payout_id, entry_type, amount_paise, description)
    values (p_venue_id, po.id, 'payout', -bal, 'Automatic payout');
    return po;
end;
$$;

-- Final state of a payout; a failed payout puts the money back on the balance
create or replace function public.complete_payout(p_payout_id uuid, p_status text, p_transfer_id text default null, p_reason text default null, p_actor_id uuid default null)
returns public.payouts
language plpgsql
security definer set search_path = public
as $$
declare
    po public.payouts;
begin
    if p_status not in ('paid', 'failed') then
        raise exception 'Payout status must be paid or failed' using errcode = 'P0001';
    end if;
    select * into po from public.payouts where id = p_payout_id for update;
    if po.id is null then
        raise exception 'Payout not found' using errcode = 'P0002';
    end if;
    if po.status <> 'processing' then
        raise exception 'Payout is already %', po.status using errcode = 'P0001';
    end if;
    update public.payouts
       set status = p_status::public.payout_status,
           razorpay_transfer_id = coalesce(p_transfer_id, razorpay_transfer_id),
           paid_at = case when p_status = 'paid' then now() end,
           failed_reason = case when p_status = 'failed' then left(p_reason, 500) end
     where id = po.id
    returning * into po;
    if p_status = 'failed' then
        insert into public.venue_ledger (venue_id, payout_id, entry_type, amount_paise, description, created_by)
        values (po.venue_id, po.id, 'payout_reversal', po.amount_paise, 'Payout failed, amount returned to balance', p_actor_id);
    end if;
    return po;
end;
$$;

-- ------------------------------------------------------------
-- Privileges: backend only
-- ------------------------------------------------------------
revoke execute on function public.platform_commission_percent() from public, anon, authenticated;
revoke execute on function public.bookings_set_commission() from public, anon, authenticated;
revoke execute on function public.booking_venue_net(public.bookings) from public, anon, authenticated;
revoke execute on function public.bookings_sync_ledger() from public, anon, authenticated;
revoke execute on function public.venue_balance(uuid) from public, anon, authenticated;
revoke execute on function public.list_venue_balances() from public, anon, authenticated;
revoke execute on function public.record_payment_captured(text, text, int, text, text) from public, anon, authenticated;
revoke execute on function public.record_payment_failed(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.bookings_queue_refund() from public, anon, authenticated;
revoke execute on function public.claim_refunds(int, int) from public, anon, authenticated;
revoke execute on function public.update_refund(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.update_refund_by_gateway_id(text, text, text) from public, anon, authenticated;
revoke execute on function public.record_manual_payout(uuid, int, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.start_route_payout(uuid, int) from public, anon, authenticated;
revoke execute on function public.complete_payout(uuid, text, text, text, uuid) from public, anon, authenticated;

grant execute on function public.platform_commission_percent() to service_role;
grant execute on function public.booking_venue_net(public.bookings) to service_role;
grant execute on function public.venue_balance(uuid) to service_role;
grant execute on function public.list_venue_balances() to service_role;
grant execute on function public.record_payment_captured(text, text, int, text, text) to service_role;
grant execute on function public.record_payment_failed(text, text, text, text) to service_role;
grant execute on function public.claim_refunds(int, int) to service_role;
grant execute on function public.update_refund(uuid, text, text, text) to service_role;
grant execute on function public.update_refund_by_gateway_id(text, text, text) to service_role;
grant execute on function public.record_manual_payout(uuid, int, text, text, uuid) to service_role;
grant execute on function public.start_route_payout(uuid, int) to service_role;
grant execute on function public.complete_payout(uuid, text, text, text, uuid) to service_role;

-- ------------------------------------------------------------
-- RLS: backend only
-- ------------------------------------------------------------
alter table public.payments enable row level security;
alter table public.refunds enable row level security;
alter table public.webhook_events enable row level security;
alter table public.venue_payout_settings enable row level security;
alter table public.payouts enable row level security;
alter table public.venue_ledger enable row level security;
