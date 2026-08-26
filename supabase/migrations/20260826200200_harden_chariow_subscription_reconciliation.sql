alter table public.billing_webhook_events
  add column if not exists processed_at timestamptz,
  add column if not exists processing_error text;

update public.billing_webhook_events
set processed_at = received_at
where processed_at is null;

create unique index if not exists subscriptions_provider_sale_unique
  on public.subscriptions (provider_sale_id)
  where provider_sale_id is not null;

create unique index if not exists subscriptions_provider_license_unique
  on public.subscriptions (provider_license_id)
  where provider_license_id is not null;

create index if not exists subscriptions_pending_checkout_idx
  on public.subscriptions (session_id, plan_slug, billing_cycle, created_at desc)
  where status = 'pending_checkout';

update public.subscriptions
set status = 'cancelled', updated_at = now()
where status = 'pending_checkout'
  and provider is null
  and provider_product_id is null
  and customer_email is null;
