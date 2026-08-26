alter table public.subscriptions
  add column if not exists billing_cycle text check (billing_cycle in ('monthly', 'annual')),
  add column if not exists provider_product_id text,
  add column if not exists provider_sale_id text,
  add column if not exists provider_license_id text,
  add column if not exists license_status text,
  add column if not exists license_expires_at timestamptz,
  add column if not exists customer_email text;

create table if not exists public.billing_webhook_events (
  id uuid primary key default gen_random_uuid(),
  delivery_id text unique,
  event text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

alter table public.billing_webhook_events enable row level security;
revoke all on public.billing_webhook_events from anon, authenticated;
drop policy if exists "billing_webhook_events_no_public_access" on public.billing_webhook_events;
create policy "billing_webhook_events_no_public_access" on public.billing_webhook_events for all to anon, authenticated using (false) with check (false);
create index if not exists subscriptions_provider_product_idx on public.subscriptions (provider_product_id);
create index if not exists subscriptions_customer_email_idx on public.subscriptions (customer_email);
