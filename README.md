# Huggy Excel

Générateur de classeurs piloté par Claude via OpenRouter, avec catalogue de plans et persistance Supabase.

## Développement local

```powershell
Copy-Item .dev.vars.example .dev.vars
# renseigner les valeurs uniquement dans .dev.vars
npm run check
npm start
```

L’interface est disponible sur `http://127.0.0.1:4173/`.

## Variables secrètes

Les secrets de production sont enregistrés dans Cloudflare Workers, jamais dans Git :

- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

La clé `SUPABASE_SERVICE_ROLE_KEY` doit rester strictement côté Worker. Elle ne doit jamais être exposée dans `app.js`, dans le navigateur ou dans une variable `NEXT_PUBLIC_*`.

## Modèles IA et routage

- demandes courantes : `anthropic/claude-sonnet-5` ;
- tâches très rapides : `anthropic/claude-haiku-4.5` ;
- tâches complexes ou Business : `anthropic/claude-opus-5`.

Les demandes sont validées par le serveur et le résultat structuré est enregistré dans Supabase.

## Plans

Le catalogue est synchronisé dans `public.plans` : Free, Starter (9,90 €/mois), Pro (24,90 €/mois) et Business (79 €/mois). L’endpoint d’abonnement enregistre une demande `pending_checkout`; un prestataire de paiement doit encore être relié pour activer la facturation réelle.

## Cloudflare

Le Worker de production est `huggy-excel`. Le dépôt contient `wrangler.jsonc`, `worker.mjs`, `api.mjs` et `public/` pour les redéploiements Wrangler.

Le domaine racine `huggy.fun/*` est routé vers le Worker. Le DNS de `huggy.fun` utilise actuellement des serveurs de noms externes ; pour rendre le domaine racine publiquement actif via Cloudflare, les serveurs de noms du registrar doivent être remplacés par `martha.ns.cloudflare.com` et `stanley.ns.cloudflare.com`. Le sous-domaine `www` existant n’a pas été modifié.
