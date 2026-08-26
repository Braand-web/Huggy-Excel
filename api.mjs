const PLAN_CATALOG = [
  { slug: 'free', name: 'Free', monthlyPriceCents: 0, generationLimit: 1, model: 'anthropic/claude-sonnet-5', effort: 'low', features: ['1 génération', 'Aperçu des classeurs', 'Exports limités'], sortOrder: 0 },
  { slug: 'starter', name: 'Starter', monthlyPriceCents: 4900, generationLimit: 50, model: 'anthropic/claude-sonnet-5', effort: 'medium', features: ['50 générations par mois', 'Création et modification Excel', 'Exports CSV/XLSX'], sortOrder: 1 },
  { slug: 'pro', name: 'Pro', monthlyPriceCents: 14900, generationLimit: 250, model: 'anthropic/claude-sonnet-5', effort: 'high', features: ['250 générations par mois', 'Tableaux de bord avancés', 'Traitement prioritaire'], sortOrder: 2 },
  { slug: 'business', name: 'Business', monthlyPriceCents: 59900, generationLimit: 1000, model: 'anthropic/claude-sonnet-5', effort: 'high', features: ['1 000 générations par mois', 'Traitement haute capacité', 'Support et espaces partagés'], sortOrder: 3 },
];

const BILLING_CATALOG = {
  starter: { monthly: { amount: 4900, days: 30, env: 'CHARIOW_PRODUCT_STARTER_MONTHLY' }, annual: { amount: 46900, days: 365, env: 'CHARIOW_PRODUCT_STARTER_ANNUAL' } },
  pro: { monthly: { amount: 14900, days: 30, env: 'CHARIOW_PRODUCT_PRO_MONTHLY' }, annual: { amount: 142900, days: 365, env: 'CHARIOW_PRODUCT_PRO_ANNUAL' } },
  business: { monthly: { amount: 59900, days: 30, env: 'CHARIOW_PRODUCT_BUSINESS_MONTHLY' }, annual: { amount: 574900, days: 365, env: 'CHARIOW_PRODUCT_BUSINESS_ANNUAL' } },
};

const SYSTEM_PROMPT = `Tu es Huggy Excel, un agent spécialisé dans la création de classeurs utiles et vérifiables. À partir de la demande de l'utilisateur, retourne uniquement un objet JSON valide avec cette structure :
{
  "title": "nom court du classeur",
  "summary": "résumé en une phrase",
  "sheets": [{ "name": "sales", "columns": ["Colonne 1"], "rows": [["Colonne 1"]] }],
  "formulas": ["formule ou règle importante"],
  "notes": ["hypothèse ou conseil utile"]
}
Crée au maximum 3 feuilles, 12 colonnes par feuille et 25 lignes par feuille. Les lignes doivent contenir les en-têtes en première ligne. Utilise des valeurs d'exemple réalistes quand l'utilisateur ne donne pas de données. N'invente jamais de secrets, de données personnelles ou de résultats financiers garantis. Pour les formules, écris des formules Excel en notation anglaise quand c'est pertinent.`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
}

function supabaseHeaders(env, prefer) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', ...(prefer ? { prefer } : {}) };
}

async function authenticatedUser(env, request) {
  const authorization = request.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+$/i.test(authorization) || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization } });
    if (!response.ok) return null;
    const user = await response.json();
    return user?.id && validSessionId(user.id) ? user : null;
  } catch { return null; }
}

function fallbackWorkbook(prompt) {
  const isBudget = /budget|dépense|depense|finance|mensuel/i.test(prompt);
  return {
    title: isBudget ? 'budget-mensuel' : 'suivi-ventes',
    summary: isBudget ? 'Budget mensuel organisé par catégorie.' : 'Suivi des ventes avec totaux calculés.',
    sheets: [{ name: isBudget ? 'budget' : 'sales', columns: isBudget ? ['Catégorie', 'Mois', 'Montant', 'Statut'] : ['Date', 'Produit', 'Quantité', 'Prix unitaire', 'Total'], rows: isBudget ? [['Catégorie', 'Mois', 'Montant', 'Statut'], ['Logement', 'Janvier', '900', 'Prévu'], ['Transport', 'Janvier', '180', 'Prévu'], ['Logiciels', 'Janvier', '75', 'Payé']] : [['Date', 'Produit', 'Quantité', 'Prix unitaire', 'Total'], ['2026-08-20', 'Produit exemple', '3', '49.90', '=C2*D2'], ['2026-08-21', 'Produit premium', '2', '88.00', '=C3*D3']] }],
    formulas: ['Total = Quantité × Prix unitaire'], notes: ['Ajoute tes propres données puis vérifie les hypothèses.'],
  };
}

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(cleaned); } catch { const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}'); if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)); throw new Error('Réponse JSON invalide du service.'); }
}

function getPlan(slug) { return PLAN_CATALOG.find(item => item.slug === slug) || PLAN_CATALOG[0]; }

function chooseModel(prompt, planSlug, requestedMode) {
  const plan = getPlan(planSlug);
  const hard = prompt.length > 260 || /multi[- ]?feuille|modèle financier|modele financier|formule complexe|dashboard|tableau de bord|prévision|prevision|consolide/i.test(prompt);
  if (hard && (plan.slug === 'pro' || plan.slug === 'business')) return { model: 'anthropic/claude-opus-5', effort: 'high' };
  if (requestedMode === 'fast' || (prompt.length < 75 && /résume|resume|nomme|corrige|liste|simple/i.test(prompt))) return { model: 'anthropic/claude-haiku-4.5', effort: null };
  return { model: plan.model, effort: plan.effort };
}

async function callOpenRouter({ apiKey, prompt, model, effort, fileName }) {
  if (!apiKey) return { workbook: fallbackWorkbook(prompt), usage: null };
  const userPrompt = `${prompt}${fileName ? `\nFichier joint à prendre en compte : ${fileName}` : ''}`;
  const base = { model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }], temperature: 0.2, max_tokens: 3500, response_format: { type: 'json_object' } };
  if (effort) base.reasoning = { effort };
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'http-referer': 'https://huggy.fun', 'x-title': 'Huggy Excel' };
  let response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(base) });
  if (!response.ok && effort) { const retry = { ...base }; delete retry.reasoning; response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(retry) }); }
  if (!response.ok) throw new Error(`Le service de génération a répondu avec le statut ${response.status}.`);
  const payload = await response.json();
  return { workbook: parseJson(payload.choices?.[0]?.message?.content), usage: payload.usage || null };
}

async function persist(env, table, row) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: supabaseHeaders(env, 'return=representation'), body: JSON.stringify(row) });
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data) ? data[0] : data;
  } catch { return null; }
}

function validSessionId(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '')); }
function periodKey(planSlug, now = new Date()) { return planSlug === 'free' ? 'free:lifetime' : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`; }

async function getEntitlement(env, sessionId) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { plan: getPlan('free'), billingCycle: null, expiresAt: null, status: 'free' };
  try {
    const select = 'plan_slug,billing_cycle,status,current_period_end,license_expires_at,updated_at';
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?select=${select}&session_id=eq.${encodeURIComponent(sessionId)}&status=eq.active&order=updated_at.desc&limit=5`, { headers: supabaseHeaders(env) });
    if (!response.ok) throw new Error('Entitlement lookup failed.');
    const rows = await response.json(); const now = Date.now();
    const active = rows.find(row => { const end = row.license_expires_at || row.current_period_end; return !end || Date.parse(end) > now; });
    if (active) return { plan: getPlan(active.plan_slug), billingCycle: active.billing_cycle || null, expiresAt: active.license_expires_at || active.current_period_end || null, status: 'active' };
  } catch { /* Fail closed to the free entitlement. */ }
  return { plan: getPlan('free'), billingCycle: null, expiresAt: null, status: 'free' };
}

async function claimGeneration(env, { sessionId, plan, prompt, model, effort }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/claim_generation_quota`, { method: 'POST', headers: supabaseHeaders(env), body: JSON.stringify({ p_session_id: sessionId, p_plan_slug: plan.slug, p_limit: plan.generationLimit, p_prompt: prompt, p_model: model, p_effort: effort, p_period_key: periodKey(plan.slug) }) });
  if (!response.ok) throw new Error('Le contrôle du quota est momentanément indisponible.');
  return response.json();
}

async function finishGeneration(env, id, status, result = null, usage = null) {
  if (!id || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  await fetch(`${env.SUPABASE_URL}/rest/v1/generations?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: supabaseHeaders(env, 'return=minimal'), body: JSON.stringify({ status, result, input_tokens: usage?.prompt_tokens || usage?.input_tokens || null, output_tokens: usage?.completion_tokens || usage?.output_tokens || null }) }).catch(() => {});
}

async function usageCount(env, sessionId, planSlug) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return 0;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/generations?select=id&session_id=eq.${encodeURIComponent(sessionId)}&period_key=eq.${encodeURIComponent(periodKey(planSlug))}&status=in.(queued,completed)`, { headers: supabaseHeaders(env, 'count=exact') });
  if (!response.ok) return 0;
  const total = Number((response.headers.get('content-range') || '').split('/')[1]);
  if (Number.isFinite(total)) return total;
  return (await response.json().catch(() => [])).length;
}

function chariowProductId(env, planSlug, billing) { const item = BILLING_CATALOG[planSlug]?.[billing]; return item ? env[item.env] : ''; }
function planForProduct(env, productId) { return Object.entries(BILLING_CATALOG).flatMap(([plan, cycles]) => Object.entries(cycles).map(([billing, item]) => ({ plan, billing, ...item, id: env[item.env] }))).find(item => item.id && item.id === productId) || null; }

async function chariowRequest(env, path, options = {}) {
  if (!env.CHARIOW_API_KEY) throw new Error('Le paiement Chariow n’est pas configuré.');
  const response = await fetch(`https://api.chariow.com/v1${path}`, { ...options, headers: { authorization: `Bearer ${env.CHARIOW_API_KEY}`, 'content-type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Chariow a répondu avec le statut ${response.status}.`);
  return payload;
}

async function updateSubscription(env, lookup, changes) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const params = Object.entries(lookup).map(([key, value]) => `${key}=eq.${encodeURIComponent(value)}`).join('&');
  try {
    const list = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?select=id&${params}&order=created_at.desc&limit=1`, { headers: supabaseHeaders(env) });
    if (!list.ok) return;
    const rows = await list.json();
    if (!rows[0]?.id) return;
    await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?id=eq.${rows[0].id}`, { method: 'PATCH', headers: supabaseHeaders(env, 'return=minimal'), body: JSON.stringify({ ...changes, updated_at: new Date().toISOString() }) });
  } catch { /* A delivery can be retried safely. */ }
}

async function claimWebhookDelivery(env, deliveryId, event, payload) {
  if (!deliveryId || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return true;
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/billing_webhook_events`, { method: 'POST', headers: supabaseHeaders(env, 'return=minimal'), body: JSON.stringify({ delivery_id: deliveryId, event, payload }) });
    if (response.status === 409) return 'duplicate';
    return response.ok;
  } catch { return false; }
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function verifyChariowSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = signature.replace(/^sha256=/i, '').trim().toLowerCase();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return constantTimeEqual(actual, expected);
}

async function handleChariowWebhook(request, env) {
  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > 262144) return json({ error: 'Charge utile trop volumineuse.' }, 413);
  const rawBody = await request.text();
  if (rawBody.length > 262144) return json({ error: 'Charge utile trop volumineuse.' }, 413);
  if (!await verifyChariowSignature(rawBody, request.headers.get('x-chariow-signature'), env.CHARIOW_WEBHOOK_SECRET)) return json({ error: 'Signature webhook invalide.' }, 401);
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: 'Charge utile webhook invalide.' }, 400); }
  const event = String(payload.event || payload.type || '').toLowerCase();
  const deliveryId = request.headers.get('x-pulse-delivery-id') || request.headers.get('x-webhook-id') || '';
  const delivery = await claimWebhookDelivery(env, deliveryId, event, payload);
  if (delivery === 'duplicate') return json({ ok: true, duplicate: true });
  if (!delivery) return json({ error: 'Événement webhook non enregistré.' }, 500);

  const data = payload.data || payload;
  const sale = data.sale || payload.sale || {};
  const productObject = data.product || sale.product || payload.product || {};
  const license = data.license || payload.license || {};
  const customer = data.customer || sale.customer || payload.customer || {};
  const productId = String(productObject.id || sale.product_id || data.product_id || '');
  const product = planForProduct(env, productId);
  const metadata = sale.custom_metadata || data.custom_metadata || payload.custom_metadata || {};
  const customerEmail = String(customer.email || sale.customer_email || data.customer_email || '').trim().toLowerCase();
  const sessionId = String(metadata.session_id || metadata.sessionId || '');
  const lookup = validSessionId(sessionId) ? { session_id: sessionId } : customerEmail ? { customer_email: customerEmail } : null;

  if (lookup && product) {
    const active = (event.includes('sale') && (event.includes('success') || event.includes('paid'))) || (event.includes('license') && /issued|activated|created/.test(event));
    const expired = /expired|revoked|refunded|cancelled|canceled/.test(event);
    const now = new Date();
    const entitlementEnd = license.expires_at || license.expiresAt || (active ? new Date(now.getTime() + product.days * 86400000).toISOString() : null);
    await updateSubscription(env, { ...lookup, plan_slug: product.plan, billing_cycle: product.billing }, {
      status: active ? 'active' : expired ? 'cancelled' : 'pending_checkout', provider: 'chariow', provider_product_id: productId,
      provider_sale_id: sale.id || data.sale_id || null, provider_license_id: license.id || null,
      license_status: license.status || (active ? 'active' : null), license_expires_at: entitlementEnd,
      current_period_start: active ? now.toISOString() : null, current_period_end: entitlementEnd, customer_email: customerEmail || null,
    });
  }
  return json({ ok: true });
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' } });
  if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, service: 'huggy-excel', configured: Boolean(env.OPENROUTER_API_KEY && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) });
  if (url.pathname === '/api/webhooks/chariow' && request.method === 'POST') return handleChariowWebhook(request, env);

  if (url.pathname === '/api/plans' && request.method === 'GET') {
    let plans = PLAN_CATALOG;
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const response = await fetch(`${env.SUPABASE_URL}/rest/v1/plans?select=slug,name,monthly_price_cents,generation_limit,features&active=eq.true&order=sort_order.asc`, { headers: supabaseHeaders(env) });
        if (response.ok) { const remote = await response.json(); if (remote.length) plans = remote.map(item => ({ slug: item.slug, name: item.name, monthlyPriceCents: item.monthly_price_cents, generationLimit: item.generation_limit, features: item.features })); }
      } catch { /* The checked-in catalog is the safe fallback. */ }
    }
    return json({ plans: plans.map(({ slug, name, monthlyPriceCents, generationLimit, features }) => ({ slug, name, monthlyPriceCents, generationLimit, features })) });
  }

  if (url.pathname === '/api/account' && request.method === 'GET') {
    const user = await authenticatedUser(env, request);
    if (!user) return json({ error: 'Connexion requise.' }, 401);
    const sessionId = user.id;
    const entitlement = await getEntitlement(env, sessionId);
    const used = await usageCount(env, sessionId, entitlement.plan.slug);
    return json({ plan: entitlement.plan.slug, planName: entitlement.plan.name, generationLimit: entitlement.plan.generationLimit, used, remaining: Math.max(0, entitlement.plan.generationLimit - used), billingCycle: entitlement.billingCycle, expiresAt: entitlement.expiresAt, status: entitlement.status });
  }

  if (url.pathname === '/api/generate' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Corps de requête invalide.' }, 400); }
    const prompt = String(body.prompt || '').trim();
    const user = await authenticatedUser(env, request);
    if (!user) return json({ error: 'Connecte-toi pour générer un fichier.' }, 401);
    const sessionId = user.id;
    if (!prompt || prompt.length > 6000) return json({ error: 'La demande doit contenir entre 1 et 6000 caractères.' }, 400);
    const entitlement = await getEntitlement(env, sessionId);
    const selection = chooseModel(prompt, entitlement.plan.slug, body.mode);
    let generationId;
    try { generationId = await claimGeneration(env, { sessionId, plan: entitlement.plan, prompt, model: selection.model, effort: selection.effort }); } catch (error) { return json({ error: error.message }, 503); }
    if (env.SUPABASE_URL && !generationId) return json({ error: 'Ton quota de générations est atteint. Choisis un plan ou attends son renouvellement.' }, 429);
    try {
      const result = await callOpenRouter({ apiKey: env.OPENROUTER_API_KEY, prompt, model: selection.model, effort: selection.effort, fileName: String(body.fileName || '').slice(0, 255) });
      await finishGeneration(env, generationId, 'completed', result.workbook, result.usage);
      const used = await usageCount(env, sessionId, entitlement.plan.slug);
      return json({ workbook: result.workbook, account: { plan: entitlement.plan.slug, generationLimit: entitlement.plan.generationLimit, used, remaining: Math.max(0, entitlement.plan.generationLimit - used) } });
    } catch (error) {
      await finishGeneration(env, generationId, 'failed');
      return json({ error: error.message || 'Impossible de contacter le service de génération.' }, 502);
    }
  }

  if (url.pathname === '/api/checkout' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Corps de requête invalide.' }, 400); }
    const planSlug = String(body.plan || '');
    const billing = body.billing === 'annual' ? 'annual' : 'monthly';
    const offer = BILLING_CATALOG[planSlug]?.[billing];
    const email = String(body.email || '').trim().toLowerCase();
    const firstName = String(body.firstName || '').trim();
    const lastName = String(body.lastName || '').trim();
    const phoneNumber = String(body.phoneNumber || '').replace(/\D/g, '');
    const countryCode = String(body.countryCode || '').trim().toUpperCase();
    const user = await authenticatedUser(env, request);
    if (!user) return json({ error: 'Connecte-toi pour continuer le paiement.' }, 401);
    const sessionId = user.id;
    if (!offer || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !firstName || !lastName || phoneNumber.length < 6 || !/^[A-Z]{2}$/.test(countryCode)) return json({ error: 'Renseigne des coordonnées de paiement valides.' }, 400);
    const productId = chariowProductId(env, planSlug, billing);
    if (!productId) return json({ error: 'Cette offre n’est pas encore configurée.' }, 503);
    const pending = await persist(env, 'subscriptions', { session_id: sessionId, plan_slug: planSlug, billing_cycle: billing, status: 'pending_checkout', provider: 'chariow', provider_product_id: productId, customer_email: email });
    if (env.SUPABASE_URL && !pending) return json({ error: 'Impossible d’enregistrer la commande.' }, 503);
    try {
      const result = await chariowRequest(env, '/checkout', { method: 'POST', body: JSON.stringify({ product_id: productId, email, first_name: firstName, last_name: lastName, phone: { number: phoneNumber, country_code: countryCode }, redirect_url: 'https://huggy.fun/?checkout=success', custom_metadata: { session_id: sessionId, plan_slug: planSlug, billing_cycle: billing } }) });
      const checkoutUrl = result.data?.payment?.checkout_url || result.data?.checkout_url || null;
      if (!checkoutUrl) throw new Error('Lien de paiement indisponible.');
      return json({ checkoutUrl, step: result.data?.step || null });
    } catch (error) { return json({ error: error.message || 'Impossible de préparer le paiement.' }, 502); }
  }

  return json({ error: 'Route API introuvable.' }, 404);
}

export { BILLING_CATALOG, PLAN_CATALOG };
