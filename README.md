# Huggy Excel

Générateur de classeurs assisté par IA, avec paiements Chariow, quotas serveur et persistance Supabase.

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
- `CHARIOW_API_KEY`
- `CHARIOW_WEBHOOK_SECRET`
- les six identifiants `CHARIOW_PRODUCT_*`

La clé `SUPABASE_SERVICE_ROLE_KEY` doit rester strictement côté Worker. Elle ne doit jamais être exposée dans `app.js`, dans le navigateur ou dans une variable `NEXT_PUBLIC_*`.

## Authentification

L’inscription et la connexion email/mot de passe passent par Supabase Auth. La clé publishable utilisée par le navigateur se trouve dans `public/config.js`; elle ne donne aucun accès privilégié. Les routes de génération, de compte et de paiement exigent un access token Supabase valide, et la session est renouvelée automatiquement côté navigateur.

## Génération et contrôle des coûts

Les droits et le routage de capacité sont déterminés exclusivement par le Worker. Le navigateur ne choisit ni le niveau de service ni le quota. Chaque génération est réservée atomiquement dans Supabase avant l’appel au fournisseur, puis marquée comme terminée ou échouée.

## Plans

Le catalogue est synchronisé dans `public.plans` : Free (1 génération), Starter (4 900 FCFA/mois ou 46 900 FCFA/an), Pro (14 900 FCFA/mois ou 142 900 FCFA/an) et Business (59 900 FCFA/mois ou 574 900 FCFA/an).

Le CTA prépare le droit côté Worker puis ouvre directement la page produit Chariow correspondante. Le Pulse signé active automatiquement le droit dans `public.subscriptions` en rapprochant l’email du compte; les quotas payants sont renouvelés chaque mois tant que la licence reste valide.

## Cloudflare

Le Worker de production est `huggy-excel`. Le dépôt contient `wrangler.jsonc`, `worker.mjs`, `api.mjs` et `public/` pour les redéploiements Wrangler.

Les domaines personnalisés `huggy.fun` et `www.huggy.fun` sont déclarés dans `wrangler.jsonc`. Le webhook Chariow reste sur l’URL stable `workers.dev` afin d’être indépendant d’un changement DNS du domaine commercial.
