create extension if not exists pgcrypto;

create table if not exists public.plans (
  slug text primary key,
  name text not null,
  monthly_price_cents integer not null default 0 check (monthly_price_cents >= 0),
  generation_limit integer not null check (generation_limit > 0),
  model text not null,
  effort text,
  features jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.generations (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  prompt text not null check (char_length(prompt) between 1 and 6000),
  model text not null,
  effort text,
  status text not null default 'completed' check (status in ('queued','completed','failed')),
  result jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  plan_slug text not null references public.plans(slug),
  status text not null default 'pending_checkout' check (status in ('pending_checkout','active','cancelled','past_due')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists generations_session_created_idx on public.generations (session_id, created_at desc);
create index if not exists subscriptions_session_idx on public.subscriptions (session_id);
create index if not exists subscriptions_plan_slug_idx on public.subscriptions (plan_slug);

alter table public.plans enable row level security;
alter table public.generations enable row level security;
alter table public.subscriptions enable row level security;

grant select on public.plans to anon, authenticated;
drop policy if exists "plans_public_read" on public.plans;
create policy "plans_public_read" on public.plans for select to anon, authenticated using (active = true);

revoke all on public.generations from anon, authenticated;
revoke all on public.subscriptions from anon, authenticated;
drop policy if exists "generations_no_public_access" on public.generations;
create policy "generations_no_public_access" on public.generations for all to anon, authenticated using (false) with check (false);
drop policy if exists "subscriptions_no_public_access" on public.subscriptions;
create policy "subscriptions_no_public_access" on public.subscriptions for all to anon, authenticated using (false) with check (false);

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

insert into public.plans (slug, name, monthly_price_cents, generation_limit, model, effort, features, sort_order)
values
  ('free', 'Free', 0, 3, 'anthropic/claude-sonnet-5', 'low', '["3 générations par mois","Aperçu des classeurs","Exports limités"]'::jsonb, 0),
  ('starter', 'Starter', 990, 50, 'anthropic/claude-sonnet-5', 'medium', '["50 générations par mois","Création et modification Excel","Exports CSV/XLSX"]'::jsonb, 1),
  ('pro', 'Pro', 2490, 250, 'anthropic/claude-sonnet-5', 'high', '["250 générations par mois","Formules et tableaux avancés","10 générations Opus incluses"]'::jsonb, 2),
  ('business', 'Business', 7900, 1000, 'anthropic/claude-opus-5', 'high', '["1 000 générations par mois","Opus prioritaire","Support et espaces partagés"]'::jsonb, 3)
on conflict (slug) do update set
  name = excluded.name,
  monthly_price_cents = excluded.monthly_price_cents,
  generation_limit = excluded.generation_limit,
  model = excluded.model,
  effort = excluded.effort,
  features = excluded.features,
  sort_order = excluded.sort_order,
  active = true,
  updated_at = now();
