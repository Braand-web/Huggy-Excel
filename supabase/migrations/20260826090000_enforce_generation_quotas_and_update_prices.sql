alter table public.generations
  add column if not exists plan_slug text references public.plans(slug),
  add column if not exists period_key text,
  add column if not exists input_tokens integer check (input_tokens is null or input_tokens >= 0),
  add column if not exists output_tokens integer check (output_tokens is null or output_tokens >= 0);

update public.generations
set plan_slug = coalesce(plan_slug, 'free'),
    period_key = coalesce(period_key, 'free:lifetime')
where plan_slug is null or period_key is null;

alter table public.generations
  alter column plan_slug set default 'free',
  alter column plan_slug set not null,
  alter column period_key set not null;

create index if not exists generations_quota_lookup_idx
  on public.generations (session_id, period_key, status, created_at desc);

update public.plans
set monthly_price_cents = case slug
      when 'free' then 0
      when 'starter' then 4900
      when 'pro' then 14900
      when 'business' then 59900
      else monthly_price_cents
    end,
    model = case when slug = 'business' then 'anthropic/claude-sonnet-5' else model end,
    updated_at = now()
where slug in ('free', 'starter', 'pro', 'business');

create or replace function public.claim_generation_quota(
  p_session_id text,
  p_plan_slug text,
  p_limit integer,
  p_prompt text,
  p_model text,
  p_effort text,
  p_period_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation_id uuid;
  v_usage bigint;
begin
  if p_session_id is null or char_length(p_session_id) < 16 then
    raise exception 'invalid session';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'invalid quota';
  end if;
  if p_period_key is null or char_length(p_period_key) > 32 then
    raise exception 'invalid period';
  end if;
  if not exists (select 1 from public.plans where slug = p_plan_slug and active = true) then
    raise exception 'invalid plan';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_session_id || ':' || p_period_key, 0)
  );

  select count(*)
  into v_usage
  from public.generations
  where session_id = p_session_id
    and period_key = p_period_key
    and status in ('queued', 'completed');

  if v_usage >= p_limit then
    return null;
  end if;

  insert into public.generations (
    session_id, plan_slug, period_key, prompt, model, effort, status
  ) values (
    p_session_id, p_plan_slug, p_period_key, p_prompt, p_model, p_effort, 'queued'
  )
  returning id into v_generation_id;

  return v_generation_id;
end;
$$;

revoke all on function public.claim_generation_quota(text, text, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_generation_quota(text, text, integer, text, text, text, text) to service_role;
