-- The app exposes a curated plan catalog through its server API.
-- Keep provider-routing fields out of the public Supabase Data API.
revoke select on public.plans from anon, authenticated;

update public.plans
set generation_limit = case slug when 'free' then 1 else generation_limit end,
    features = case slug
      when 'free' then '["1 génération","Aperçu des classeurs","Exports limités"]'::jsonb
      when 'pro' then '["250 générations par mois","Tableaux de bord avancés","Traitement prioritaire"]'::jsonb
      when 'business' then '["1 000 générations par mois","Traitement haute capacité","Support et espaces partagés"]'::jsonb
      else features
    end,
    updated_at = now()
where slug in ('free', 'pro', 'business');
