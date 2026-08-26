const PLAN_CATALOG = [
  { slug: 'free', name: 'Free', monthlyPriceCents: 0, generationLimit: 1, model: 'anthropic/claude-sonnet-5', effort: 'low', features: ['1 génération', 'Aperçu des classeurs', 'Exports limités'], sortOrder: 0 },
  { slug: 'starter', name: 'Starter', monthlyPriceCents: 990, generationLimit: 50, model: 'anthropic/claude-sonnet-5', effort: 'medium', features: ['50 générations par mois', 'Création et modification Excel', 'Exports CSV/XLSX'], sortOrder: 1 },
  { slug: 'pro', name: 'Pro', monthlyPriceCents: 2490, generationLimit: 250, model: 'anthropic/claude-sonnet-5', effort: 'high', features: ['250 générations par mois', 'Tableaux de bord avancés', 'Traitement prioritaire'], sortOrder: 2 },
  { slug: 'business', name: 'Business', monthlyPriceCents: 7900, generationLimit: 1000, model: 'anthropic/claude-opus-5', effort: 'high', features: ['1 000 générations par mois', 'Traitement haute capacité', 'Support et espaces partagés'], sortOrder: 3 },
];

const BILLING_CATALOG = {
  starter: { monthly: { amount: 9900, days: 30, env: 'CHARIOW_PRODUCT_STARTER_MONTHLY' }, annual: { amount: 95040, days: 365, env: 'CHARIOW_PRODUCT_STARTER_ANNUAL' } },
  pro: { monthly: { amount: 24900, days: 30, env: 'CHARIOW_PRODUCT_PRO_MONTHLY' }, annual: { amount: 239040, days: 365, env: 'CHARIOW_PRODUCT_PRO_ANNUAL' } },
  business: { monthly: { amount: 79000, days: 30, env: 'CHARIOW_PRODUCT_BUSINESS_MONTHLY' }, annual: { amount: 758400, days: 365, env: 'CHARIOW_PRODUCT_BUSINESS_ANNUAL' } },
};

const SYSTEM_PROMPT = `Tu es Huggy Excel, un agent spécialisé dans la création de classeurs utiles et vérifiables. À partir de la demande de l'utilisateur, retourne uniquement un objet JSON valide avec cette structure :
{
  "title": "nom court du classeur",
  "summary": "résumé en une phrase",
  "sheets": [
    { "name": "sales", "columns": ["Colonne 1"], "rows": [["Colonne 1"]] }
  ],
  "formulas": ["formule ou règle importante"],
  "notes": ["hypothèse ou conseil utile"]
}
Crée au maximum 3 feuilles, 12 colonnes par feuille et 25 lignes par feuille. Les lignes doivent contenir les en-têtes en première ligne. Utilise des valeurs d'exemple réalistes quand l'utilisateur ne donne pas de données. N'invente jamais de secrets, de données personnelles ou de résultats financiers garantis. Pour les formules, écris des formules Excel en notation anglaise quand c'est pertinent.`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
}

function fallbackWorkbook(prompt) {
  const lower = prompt.toLowerCase();
  const isBudget = /budget|dépense|depense|finance|mensuel/.test(lower);
  return {
    title: isBudget ? 'budget-mensuel' : 'suivi-ventes',
    summary: isBudget ? 'Budget mensuel organisé par catégorie.' : 'Suivi des ventes avec totaux calculés.',
    sheets: [{ name: isBudget ? 'budget' : 'sales', columns: isBudget ? ['Catégorie', 'Mois', 'Montant', 'Statut'] : ['Date', 'Produit', 'Quantité', 'Prix unitaire', 'Total'], rows: isBudget ? [['Catégorie', 'Mois', 'Montant', 'Statut'], ['Logement', 'Janvier', '900', 'Prévu'], ['Transport', 'Janvier', '180', 'Prévu'], ['Logiciels', 'Janvier', '75', 'Payé']] : [['Date', 'Produit', 'Quantité', 'Prix unitaire', 'Total'], ['2026-08-20', 'Produit exemple', '3', '49.90', '=C2*D2'], ['2026-08-21', 'Produit premium', '2', '88.00', '=C3*D3']] }],
    formulas: ['Total = Quantité × Prix unitaire'],
    notes: ['Ajoute tes propres données puis vérifie les hypothèses.'],
  };
}

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(cleaned); } catch { const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}'); if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)); throw new Error('Réponse JSON invalide du modèle.'); }
}

function chooseModel(prompt, planSlug, requestedMode) {
  const plan = PLAN_CATALOG.find(item => item.slug === planSlug) || PLAN_CATALOG[0];
  const hard = prompt.length > 260 || /multi[- ]?feuille|modèle financier|modele financier|formule complexe|dashboard|tableau de bord|prévision|prevision|consolide/i.test(prompt);
  if (requestedMode === 'premium' || plan.slug === 'business' || (hard && plan.slug === 'pro')) return { model: 'anthropic/claude-opus-5', effort: 'high' };
  if (requestedMode === 'fast' || (prompt.length < 75 && /résume|resume|nomme|corrige|liste|simple/i.test(prompt))) return { model: 'anthropic/claude-haiku-4.5', effort: null };
  return { model: plan.model || 'anthropic/claude-sonnet-5', effort: plan.effort || 'medium' };
}

async function callOpenRouter({ apiKey, prompt, model, effort, fileName }) {
  if (!apiKey) return { workbook: fallbackWorkbook(prompt), usage: null };
  const userPrompt = `${prompt}${fileName ? `\nFichier joint à prendre en compte : ${fileName}` : ''}`;
  const base = { model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }], temperature: 0.2, max_tokens: 6000, response_format: { type: 'json_object' } };
  if (effort) base.reasoning = { effort };
  let response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'http-referer': 'https://huggy.fun', 'x-title': 'Huggy Excel' }, body: JSON.stringify(base) });
  if (!response.ok && effort) {
    const retry = { ...base }; delete retry.reasoning;
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'http-referer': 'https://huggy.fun', 'x-title': 'Huggy Excel' }, body: JSON.stringify(retry) });
  }
  if (!response.ok) throw new Error(`OpenRouter a répondu avec le statut ${response.status}.`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  return { workbook: parseJson(content), usage: payload.usage || null };
}

async function persist(env, table, row) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify(row) });
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data) ? data[0] : data;
  } catch { /* Persistence must not make a successful generation fail. */ }
}

function chariowProductId(env, planSlug, billing) { const item = BILLING_CATALOG[planSlug]?.[billing]; return item ? env[item.env] : ''; }
function planForProduct(env, productId) { return Object.entries(BILLING_CATALOG).flatMap(([plan, cycles]) => Object.entries(cycles).map(([billing, item]) => ({ plan, billing, id: env[item.env] }))).find(item => item.id && item.id === productId) || null; }

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
    const list = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?select=id&${params}&order=created_at.desc&limit=1`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
    if (!list.ok) return;
    const rows = await list.json();
    if (!rows[0]?.id) return;
    await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?id=eq.${rows[0].id}`, { method: 'PATCH', headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ ...changes, updated_at: new Date().toISOString() }) });
  } catch { /* Webhook processing remains idempotent if a secondary update fails. */ }
}

async function claimWebhookDelivery(env, deliveryId, event, payload) {
  if (!deliveryId || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return true;
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/billing_webhook_events`, { method: 'POST', headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ delivery_id: deliveryId, event, payload }) });
    if (response.status === 409) return 'duplicate';
    return response.ok;
  } catch { return false; }
}

async function verifyChariowSignature(rawBody, signature, secret) {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const expected = signature.slice(7);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return actual.length === expected.length && [...actual].every((char, index) => char === expected[index]);
}

async function handleChariowWebhook(request, env) {
  const rawBody = await request.text();
  if (!await verifyChariowSignature(rawBody, request.headers.get('x-chariow-signature'), env.CHARIOW_WEBHOOK_SECRET)) return json({ error: 'Signature webhook invalide.' }, 401);
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: 'Charge utile webhook invalide.' }, 400); }
  const event = String(payload.event || '');
  const deliveryId = request.headers.get('x-pulse-delivery-id') || '';
  const delivery = await claimWebhookDelivery(env, deliveryId, event, payload);
  if (delivery === 'duplicate') return json({ ok: true, duplicate: true });
  if (!delivery) return json({ error: 'Événement webhook non enregistré.' }, 500);
  const productId = payload.product?.id || '';
  const product = planForProduct(env, productId);
  const metadata = payload.sale?.custom_metadata || {};
  const customerEmail = payload.customer?.email || '';
  const sessionId = String(metadata.session_id || '');
  const lookup = sessionId ? { session_id: sessionId } : customerEmail ? { customer_email: customerEmail } : null;
  if (lookup && product) {
    const license = payload.license || {};
    const active = ['successful.sale', 'license.issued', 'license.activated'].includes(event);
    const expired = ['license.expired', 'license.revoked'].includes(event);
    await updateSubscription(env, { ...lookup, plan_slug: product.plan, billing_cycle: product.billing }, {
      status: active ? 'active' : expired ? 'cancelled' : 'pending_checkout',
      provider: 'chariow',
      provider_product_id: productId,
      provider_sale_id: payload.sale?.id || null,
      provider_license_id: license.id || null,
      license_status: license.status || null,
      license_expires_at: license.expires_at || null,
      customer_email: customerEmail || null,
    });
  }
  return json({ ok: true });
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' } });
  if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, service: 'huggy-excel', provider: 'openrouter', configured: Boolean(env.OPENROUTER_API_KEY) });
  if (url.pathname === '/api/webhooks/chariow' && request.method === 'POST') return handleChariowWebhook(request, env);
  if (url.pathname === '/api/plans' && request.method === 'GET') {
    let plans = PLAN_CATALOG;
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      try { const response = await fetch(`${env.SUPABASE_URL}/rest/v1/plans?select=slug,name,monthly_price_cents,generation_limit,features&active=eq.true&order=sort_order.asc`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }); if (response.ok) { const remote = await response.json(); if (remote.length) plans = remote.map(item => ({ slug: item.slug, name: item.name, monthlyPriceCents: item.monthly_price_cents, generationLimit: item.generation_limit, features: item.features })); } } catch { /* Use the checked-in catalog when Supabase is unavailable. */ }
    }
    return json({ plans: plans.map(({ slug, name, monthlyPriceCents, generationLimit, features }) => ({ slug, name, monthlyPriceCents, generationLimit, features })) });
  }
  if (url.pathname === '/api/generate' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Corps de requête invalide.' }, 400); }
    const prompt = String(body.prompt || '').trim();
    if (!prompt || prompt.length > 6000) return json({ error: 'La demande doit contenir entre 1 et 6000 caractères.' }, 400);
    const selection = chooseModel(prompt, String(body.plan || 'free'), body.mode);
    let result;
    try { result = await callOpenRouter({ apiKey: env.OPENROUTER_API_KEY, prompt, model: selection.model, effort: selection.effort, fileName: String(body.fileName || '') }); } catch (error) { return json({ error: error.message || 'Impossible de contacter le modèle IA.' }, 502); }
    await persist(env, 'generations', { session_id: String(body.sessionId || 'anonymous'), prompt, model: selection.model, effort: selection.effort, status: 'completed', result: result.workbook });
    return json({ workbook: result.workbook });
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
    const countryCode = String(body.countryCode || 'FR').trim().toUpperCase();
    if (!offer || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !firstName || !lastName || !phoneNumber) return json({ error: 'Renseigne tes coordonnées de paiement.' }, 400);
    const productId = chariowProductId(env, planSlug, billing);
    if (!productId) return json({ error: 'Cette offre n’est pas encore configurée.' }, 503);
    const sessionId = String(body.sessionId || 'anonymous');
    await persist(env, 'subscriptions', { session_id: sessionId, plan_slug: planSlug, billing_cycle: billing, status: 'pending_checkout', provider: 'chariow', provider_product_id: productId, customer_email: email });
    try {
      const result = await chariowRequest(env, '/checkout', { method: 'POST', body: JSON.stringify({ product_id: productId, email, first_name: firstName, last_name: lastName, phone: { number: phoneNumber, country_code: countryCode }, redirect_url: 'https://huggy.fun/?checkout=success', custom_metadata: { session_id: sessionId, plan_slug: planSlug, billing_cycle: billing } }) });
      return json({ checkoutUrl: result.data?.payment?.checkout_url || result.data?.checkout_url || null, step: result.data?.step || null });
    } catch (error) { return json({ error: error.message || 'Impossible de préparer le paiement.' }, 502); }
  }
  if (url.pathname === '/api/subscribe' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Corps de requête invalide.' }, 400); }
    const plan = PLAN_CATALOG.find(item => item.slug === body.plan);
    if (!plan || plan.slug === 'free') return json({ error: 'Plan invalide.' }, 400);
    await persist(env, 'subscriptions', { session_id: String(body.sessionId || 'anonymous'), plan_slug: plan.slug, status: 'pending_checkout' });
    return json({ ok: true, plan: plan.slug, billing: 'not_configured', message: 'Plan enregistré. Branche un prestataire de paiement pour activer la facturation.' });
  }
  return json({ error: 'Route API introuvable.' }, 404);
}

export { PLAN_CATALOG };
