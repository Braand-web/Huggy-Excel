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

function configuredAdminEmails(env) {
  return String(env.HUGGY_ADMIN_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
}

function isAdminUser(env, user) {
  const metadata = user?.app_metadata || {};
  const roles = Array.isArray(metadata.roles) ? metadata.roles : [metadata.role];
  return roles.some(role => String(role || '').toLowerCase() === 'admin') || configuredAdminEmails(env).includes(String(user?.email || '').trim().toLowerCase());
}

async function requireAdmin(env, request) {
  const user = await authenticatedUser(env, request);
  if (!user) return { response: json({ error: 'Connexion requise.' }, 401) };
  if (!isAdminUser(env, user)) return { response: json({ error: 'Accès administrateur requis.' }, 403) };
  return { user };
}

async function adminSupabaseRequest(env, path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase n’est pas configuré.');
  const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...options, headers: { ...supabaseHeaders(env), ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Supabase a répondu avec le statut ${response.status}.`);
  return payload;
}

async function listAuthUsers(env) {
  const users = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = await adminSupabaseRequest(env, `/auth/v1/admin/users?page=${page}&per_page=1000`);
    const batch = Array.isArray(payload.users) ? payload.users : [];
    users.push(...batch);
    if (batch.length < 1000) break;
  }
  return users;
}

async function listAdminTable(env, table, select, limit = 500, order = 'created_at') {
  try {
    const query = `?select=${encodeURIComponent(select)}&order=${encodeURIComponent(order)}.desc&limit=${limit}`;
    const rows = await adminSupabaseRequest(env, `/rest/v1/${table}${query}`);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function adminDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function adminSnapshot(env, admin) {
  const [authUsers, generations, subscriptions, plans, webhookEvents] = await Promise.all([
    listAuthUsers(env),
    listAdminTable(env, 'generations', 'id,session_id,plan_slug,prompt,model,effort,status,created_at,input_tokens,output_tokens', 500),
    listAdminTable(env, 'subscriptions', 'id,session_id,plan_slug,status,billing_cycle,provider,provider_product_id,provider_sale_id,provider_license_id,license_status,license_expires_at,current_period_start,current_period_end,customer_email,created_at,updated_at', 500),
    listAdminTable(env, 'plans', 'slug,name,monthly_price_cents,generation_limit,features,active,sort_order,updated_at', 20),
    listAdminTable(env, 'billing_webhook_events', 'id,delivery_id,event,received_at', 30, 'received_at'),
  ]);
  const userById = new Map(authUsers.map(user => [user.id, user]));
  const planBySlug = new Map(plans.map(plan => [plan.slug, plan]));
  const now = Date.now();
  const activeSubscription = subscription => subscription.status === 'active' && (!subscription.license_expires_at && !subscription.current_period_end || Date.parse(subscription.license_expires_at || subscription.current_period_end) > now);
  const today = new Date().toISOString().slice(0, 10);
  const activeSubscriptions = subscriptions.filter(activeSubscription);
  const mrrCents = activeSubscriptions.reduce((total, subscription) => {
    const offer = BILLING_CATALOG[subscription.plan_slug]?.[subscription.billing_cycle || 'monthly'];
    return total + (offer ? Math.round(offer.amount / (offer.days > 31 ? 12 : 1)) : Number(planBySlug.get(subscription.plan_slug)?.monthly_price_cents || 0));
  }, 0);
  const userSummary = authUsers.map(user => {
    const subscription = subscriptions.find(item => item.session_id === user.id && activeSubscription(item));
    const userGenerations = generations.filter(item => item.session_id === user.id);
    return { id: user.id, email: user.email || '', createdAt: adminDate(user.created_at), lastSignInAt: adminDate(user.last_sign_in_at), confirmedAt: adminDate(user.confirmed_at), plan: subscription?.plan_slug || 'free', generationCount: userGenerations.length, provider: user.app_metadata?.provider || null };
  }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const generationSummary = generations.map(generation => ({ ...generation, email: userById.get(generation.session_id)?.email || subscriptions.find(item => item.session_id === generation.session_id)?.customer_email || 'Utilisateur inconnu', createdAt: adminDate(generation.created_at) }));
  const subscriptionSummary = subscriptions.map(subscription => ({ ...subscription, email: userById.get(subscription.session_id)?.email || subscription.customer_email || 'Utilisateur inconnu', planName: planBySlug.get(subscription.plan_slug)?.name || subscription.plan_slug, createdAt: adminDate(subscription.created_at), updatedAt: adminDate(subscription.updated_at), expiresAt: adminDate(subscription.license_expires_at || subscription.current_period_end) }));
  return {
    admin: { email: admin.email || '', userId: admin.id },
    metrics: {
      users: authUsers.length,
      generations: generations.length,
      generationsToday: generations.filter(item => String(item.created_at || '').startsWith(today)).length,
      completedGenerations: generations.filter(item => item.status === 'completed').length,
      failedGenerations: generations.filter(item => item.status === 'failed').length,
      activeSubscriptions: activeSubscriptions.length,
      pendingSubscriptions: subscriptions.filter(item => item.status === 'pending_checkout').length,
      mrrCents,
      webhookEvents: webhookEvents.length,
    },
    users: userSummary.slice(0, 200),
    generations: generationSummary.slice(0, 200),
    subscriptions: subscriptionSummary.slice(0, 200),
    plans: plans.sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)),
    system: { environment: 'production', supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY), openrouter: Boolean(env.OPENROUTER_API_KEY), chariow: Boolean(env.CHARIOW_API_KEY && Object.values(BILLING_CATALOG).every(cycle => Object.values(cycle).every(item => env[item.env]))), lastWebhookAt: webhookEvents[0]?.received_at ? adminDate(webhookEvents[0].received_at) : null },
  };
}

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(cleaned); } catch { const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}'); if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)); throw new Error('Réponse JSON invalide du service.'); }
}

function normalizeWorkbook(input, prompt) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.sheets)) throw new Error('Le moteur IA n’a pas renvoyé de classeur exploitable.');
  const sheets = input.sheets.slice(0, 5).map((sheet, index) => {
    if (!sheet || typeof sheet !== 'object') return null;
    const columns = Array.isArray(sheet.columns) ? sheet.columns.slice(0, 20).map(value => String(value ?? '').slice(0, 240)) : [];
    const rows = Array.isArray(sheet.rows) ? sheet.rows.slice(0, 100).filter(Array.isArray).map(row => row.slice(0, 20).map(value => {
      if (value === null || value === undefined) return '';
      return ['string', 'number', 'boolean'].includes(typeof value) ? value : JSON.stringify(value);
    })) : [];
    if (!rows.length && columns.length) rows.push(columns);
    if (!rows.length) return null;
    return { name: String(sheet.name || `Feuille ${index + 1}`).trim().slice(0, 60) || `Feuille ${index + 1}`, columns, rows };
  }).filter(Boolean);
  if (!sheets.length) throw new Error('Le moteur IA n’a produit aucune feuille de calcul.');
  const requestedTitle = String(input.title || prompt || 'Classeur Huggy').trim();
  return {
    title: requestedTitle.slice(0, 120) || 'Classeur Huggy',
    summary: String(input.summary || '').trim().slice(0, 600),
    sheets,
    formulas: Array.isArray(input.formulas) ? input.formulas.slice(0, 30).map(value => String(value).slice(0, 500)) : [],
    notes: Array.isArray(input.notes) ? input.notes.slice(0, 30).map(value => String(value).slice(0, 500)) : [],
  };
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
  if (!apiKey) throw new Error('Le moteur IA n’est pas configuré. Réessaie plus tard.');
  const userPrompt = `${prompt}${fileName ? `\nFichier joint à prendre en compte : ${fileName}` : ''}`;
  const base = { model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }], temperature: 0.2, max_tokens: 3500, response_format: { type: 'json_object' } };
  if (effort) base.reasoning = { effort };
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'http-referer': 'https://huggy.fun', 'x-title': 'Huggy Excel' };
  let response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(base) });
  if (!response.ok && effort) { const retry = { ...base }; delete retry.reasoning; response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(retry) }); }
  if (!response.ok) throw new Error(`Le service de génération a répondu avec le statut ${response.status}.`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('Le moteur IA a renvoyé une réponse vide.');
  return { workbook: normalizeWorkbook(parseJson(content), prompt), usage: payload.usage || null };
}

async function persist(env, table, row) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: supabaseHeaders(env, 'return=representation'), body: JSON.stringify(row) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || data?.error || `Supabase a répondu avec le statut ${response.status}.`);
  return Array.isArray(data) ? data[0] : data;
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
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return false;
  const params = Object.entries(lookup).map(([key, value]) => `${key}=eq.${encodeURIComponent(value)}`).join('&');
  const list = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?select=id,session_id,plan_slug,billing_cycle,status,provider_product_id,provider_sale_id,provider_license_id,customer_email,current_period_start,current_period_end,license_expires_at&${params}&order=created_at.desc&limit=1`, { headers: supabaseHeaders(env) });
  if (!list.ok) throw new Error(`Recherche d’abonnement impossible (${list.status}).`);
  const rows = await list.json();
  if (!rows[0]?.id) return false;
  if (!changes) return rows[0];
  const patch = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?id=eq.${encodeURIComponent(rows[0].id)}`, { method: 'PATCH', headers: supabaseHeaders(env, 'return=minimal'), body: JSON.stringify({ ...changes, updated_at: new Date().toISOString() }) });
  if (!patch.ok) throw new Error(`Mise à jour d’abonnement impossible (${patch.status}).`);
  return rows[0];
}

async function claimWebhookDelivery(env, deliveryId, event, payload) {
  if (!deliveryId || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { claimed: true, test: !deliveryId };
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/billing_webhook_events`, { method: 'POST', headers: supabaseHeaders(env, 'return=minimal'), body: JSON.stringify({ delivery_id: deliveryId, event, payload }) });
    if (response.ok) return { claimed: true };
    if (response.status !== 409) return { claimed: false };
    const existing = await fetch(`${env.SUPABASE_URL}/rest/v1/billing_webhook_events?select=processed_at&delivery_id=eq.${encodeURIComponent(deliveryId)}&limit=1`, { headers: supabaseHeaders(env) });
    if (!existing.ok) return { claimed: false };
    const rows = await existing.json();
    return rows[0]?.processed_at ? { claimed: false, duplicate: true } : { claimed: true, retry: true };
  } catch { return { claimed: false }; }
}

async function finishWebhookDelivery(env, deliveryId, error = null) {
  if (!deliveryId || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const changes = error
    ? { processing_error: String(error.message || error).slice(0, 1000), processed_at: null }
    : { processing_error: null, processed_at: new Date().toISOString() };
  await fetch(`${env.SUPABASE_URL}/rest/v1/billing_webhook_events?delivery_id=eq.${encodeURIComponent(deliveryId)}`, { method: 'PATCH', headers: supabaseHeaders(env, 'return=minimal'), body: JSON.stringify(changes) });
}

async function saveCheckoutSubscription(env, row) {
  const existing = await updateSubscription(env, {
    session_id: row.session_id,
    plan_slug: row.plan_slug,
    billing_cycle: row.billing_cycle,
    status: 'pending_checkout',
  }, row);
  return existing || persist(env, 'subscriptions', row);
}

async function reconcileChariowSubscription(env, details) {
  const { event, product, productId, saleId, licenseId, sessionId, customerEmail, license } = details;
  const active = event === 'successful.sale' || event === 'license.issued' || event === 'license.activated';
  const cancelled = event === 'abandoned.sale' || event === 'failed.sale' || event === 'license.expired' || event === 'license.revoked';
  const nearingExpiry = event === 'license.nearing_expiry';
  if (!active && !cancelled && !nearingExpiry) return { ignored: 'unsupported_event' };

  const candidates = [
    saleId ? { provider_sale_id: saleId } : null,
    licenseId ? { provider_license_id: licenseId } : null,
    product && validSessionId(sessionId) ? { session_id: sessionId, plan_slug: product.plan, billing_cycle: product.billing } : null,
    product && customerEmail ? { customer_email: customerEmail, plan_slug: product.plan, billing_cycle: product.billing } : null,
  ].filter(Boolean);
  let subscription = null;
  for (const lookup of candidates) {
    subscription = await updateSubscription(env, lookup, null);
    if (subscription) break;
  }

  if (!subscription && active && product && validSessionId(sessionId)) {
    subscription = await persist(env, 'subscriptions', {
      session_id: sessionId,
      plan_slug: product.plan,
      billing_cycle: product.billing,
      status: 'pending_checkout',
      provider: 'chariow',
      provider_product_id: productId,
      provider_sale_id: saleId || null,
      provider_license_id: licenseId || null,
      customer_email: customerEmail || null,
    });
  }
  if (!subscription) return { ignored: product ? 'subscription_not_found' : 'unknown_product' };

  const resolvedPlan = product || BILLING_CATALOG[subscription.plan_slug]?.[subscription.billing_cycle || 'monthly'];
  const now = new Date();
  const explicitExpiry = license.expires_at || license.expiresAt || null;
  const entitlementEnd = explicitExpiry || (active && resolvedPlan ? new Date(now.getTime() + resolvedPlan.days * 86400000).toISOString() : subscription.license_expires_at || subscription.current_period_end || null);
  const changes = {
    status: active ? 'active' : cancelled ? 'cancelled' : subscription.status,
    provider: 'chariow',
    provider_product_id: productId || subscription.provider_product_id || null,
    provider_sale_id: saleId || subscription.provider_sale_id || null,
    provider_license_id: licenseId || subscription.provider_license_id || null,
    license_status: license.status || (active ? 'active' : cancelled ? 'inactive' : null),
    license_expires_at: entitlementEnd,
    current_period_start: active ? subscription.current_period_start || now.toISOString() : undefined,
    current_period_end: entitlementEnd,
    customer_email: customerEmail || subscription.customer_email || null,
  };
  Object.keys(changes).forEach(key => changes[key] === undefined && delete changes[key]);
  await updateSubscription(env, { id: subscription.id }, changes);
  return { updated: true, status: changes.status };
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
  const event = String(payload.event || payload.type || request.headers.get('x-pulse-event') || '').trim().toLowerCase();
  const deliveryId = request.headers.get('x-pulse-delivery-id') || request.headers.get('x-webhook-id') || '';
  const delivery = await claimWebhookDelivery(env, deliveryId, event, payload);
  if (delivery.duplicate) return json({ ok: true, duplicate: true });
  if (!delivery.claimed) return json({ error: 'Événement webhook non enregistré.' }, 500);
  if (payload.note) {
    await finishWebhookDelivery(env, deliveryId);
    return json({ ok: true, test: true });
  }

  try {
    const data = payload.data || payload;
    const sale = data.sale || payload.sale || {};
    const productObject = data.product || sale.product || payload.product || {};
    const license = data.license || payload.license || {};
    const customer = data.customer || sale.customer || payload.customer || {};
    const productId = String(productObject.id || sale.product_id || data.product_id || '').trim();
    const metadata = sale.custom_metadata || data.custom_metadata || payload.custom_metadata || {};
    const details = {
      event,
      productId,
      product: planForProduct(env, productId),
      saleId: String(sale.id || data.sale_id || '').trim(),
      licenseId: String(license.id || data.license_id || '').trim(),
      sessionId: String(metadata.session_id || metadata.sessionId || '').trim(),
      customerEmail: String(customer.email || sale.customer_email || data.customer_email || '').trim().toLowerCase(),
      license,
    };
    const result = await reconcileChariowSubscription(env, details);
    await finishWebhookDelivery(env, deliveryId);
    return json({ ok: true, ...result });
  } catch (error) {
    await finishWebhookDelivery(env, deliveryId, error).catch(() => {});
    return json({ error: 'Synchronisation de l’abonnement impossible.' }, 500);
  }
}

function generationStream(env, { sessionId, prompt, fileName, fileText }) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      (async () => {
        let generationId;
        try {
          send('stage', { stage: 1, label: 'request_received' });
          const entitlement = await getEntitlement(env, sessionId);
          const selection = chooseModel(prompt, entitlement.plan.slug);
          generationId = await claimGeneration(env, { sessionId, plan: entitlement.plan, prompt, model: selection.model, effort: selection.effort });
          if (env.SUPABASE_URL && !generationId) { send('error', { error: 'Ton quota de générations est atteint. Choisis un plan ou attends son renouvellement.', status: 429 }); return; }
          send('stage', { stage: 2, label: 'ai_started' });
          const modelPrompt = fileText ? `${prompt}\n\nVoici le contenu CSV du fichier joint. Utilise-le comme source de vérité et conserve les données utiles dans le classeur :\n\n${fileText}` : prompt;
          const result = await callOpenRouter({ apiKey: env.OPENROUTER_API_KEY, prompt: modelPrompt, model: selection.model, effort: selection.effort, fileName });
          send('stage', { stage: 3, label: 'workbook_received' });
          send('stage', { stage: 4, label: 'result_saved' });
          await finishGeneration(env, generationId, 'completed', result.workbook, result.usage);
          const used = await usageCount(env, sessionId, entitlement.plan.slug);
          send('stage', { stage: 5, label: 'response_ready' });
          send('complete', { workbook: result.workbook, account: { plan: entitlement.plan.slug, generationLimit: entitlement.plan.generationLimit, used, remaining: Math.max(0, entitlement.plan.generationLimit - used) } });
        } catch (error) {
          await finishGeneration(env, generationId, 'failed');
          send('error', { error: error.message || 'Impossible de terminer la génération.', status: 502 });
        } finally { controller.close(); }
      })();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'access-control-allow-origin': '*' } });
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' } });
  if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, service: 'huggy-excel', configured: Boolean(env.OPENROUTER_API_KEY && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) });
  if (url.pathname === '/api/webhooks/chariow' && request.method === 'POST') return handleChariowWebhook(request, env);

  if (url.pathname === '/api/admin/dashboard' && request.method === 'GET') {
    const access = await requireAdmin(env, request);
    if (access.response) return access.response;
    try { return json(await adminSnapshot(env, access.user)); } catch (error) { return json({ error: error.message || 'Impossible de charger les données administrateur.' }, 503); }
  }

  if (url.pathname.startsWith('/api/admin/plans/') && request.method === 'PATCH') {
    const access = await requireAdmin(env, request);
    if (access.response) return access.response;
    const slug = url.pathname.slice('/api/admin/plans/'.length);
    if (!/^[a-z0-9-]{2,32}$/.test(slug)) return json({ error: 'Plan invalide.' }, 400);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Corps de requête invalide.' }, 400); }
    const changes = {};
    if (body.monthlyPriceCents !== undefined) { const value = Number(body.monthlyPriceCents); if (!Number.isInteger(value) || value < 0 || value > 100000000) return json({ error: 'Prix invalide.' }, 400); changes.monthly_price_cents = value; }
    if (body.generationLimit !== undefined) { const value = Number(body.generationLimit); if (!Number.isInteger(value) || value < 1 || value > 1000000) return json({ error: 'Quota invalide.' }, 400); changes.generation_limit = value; }
    if (body.active !== undefined) { if (typeof body.active !== 'boolean') return json({ error: 'Statut invalide.' }, 400); changes.active = body.active; }
    if (body.features !== undefined) { if (!Array.isArray(body.features)) return json({ error: 'Fonctionnalités invalides.' }, 400); changes.features = body.features.map(item => String(item).trim()).filter(Boolean).slice(0, 10); }
    if (!Object.keys(changes).length) return json({ error: 'Aucune modification.' }, 400);
    changes.updated_at = new Date().toISOString();
    try {
      const rows = await adminSupabaseRequest(env, `/rest/v1/plans?slug=eq.${encodeURIComponent(slug)}`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify(changes) });
      return json({ plan: Array.isArray(rows) ? rows[0] || null : rows });
    } catch (error) { return json({ error: error.message || 'Impossible de mettre à jour le plan.' }, 503); }
  }

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
    const fileText = String(body.fileText || '').slice(0, 12000);
    const user = await authenticatedUser(env, request);
    if (!user) return json({ error: 'Connecte-toi pour générer un fichier.' }, 401);
    const sessionId = user.id;
    if (!prompt || prompt.length > 6000) return json({ error: 'La demande doit contenir entre 1 et 6000 caractères.' }, 400);
    if (request.headers.get('accept')?.includes('text/event-stream')) return generationStream(env, { sessionId, prompt, fileName: String(body.fileName || '').slice(0, 255), fileText });
    const entitlement = await getEntitlement(env, sessionId);
    const selection = chooseModel(prompt, entitlement.plan.slug, body.mode);
    let generationId;
    try { generationId = await claimGeneration(env, { sessionId, plan: entitlement.plan, prompt, model: selection.model, effort: selection.effort }); } catch (error) { return json({ error: error.message }, 503); }
    if (env.SUPABASE_URL && !generationId) return json({ error: 'Ton quota de générations est atteint. Choisis un plan ou attends son renouvellement.' }, 429);
    try {
      const modelPrompt = fileText ? `${prompt}\n\nVoici le contenu CSV du fichier joint. Utilise-le comme source de vérité et conserve les données utiles dans le classeur :\n\n${fileText}` : prompt;
      const result = await callOpenRouter({ apiKey: env.OPENROUTER_API_KEY, prompt: modelPrompt, model: selection.model, effort: selection.effort, fileName: String(body.fileName || '').slice(0, 255) });
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
    const user = await authenticatedUser(env, request);
    if (!user) return json({ error: 'Connecte-toi pour continuer le paiement.' }, 401);
    const sessionId = user.id;
    const email = String(user.email || '').trim().toLowerCase();
    if (!offer || !email) return json({ error: 'Compte Huggy sans adresse email valide.' }, 400);
    const productId = chariowProductId(env, planSlug, billing);
    if (!productId) return json({ error: 'Cette offre n’est pas encore configurée.' }, 503);
    const metadata = user.user_metadata || {};
    const firstName = String(metadata.first_name || metadata.firstName || '').trim();
    const lastName = String(metadata.last_name || metadata.lastName || '').trim();
    const phoneNumber = String(metadata.phone || '').replace(/\D/g, '');
    const countryCode = String(metadata.country_code || 'CI').trim().toUpperCase();
    if (!firstName || !lastName || phoneNumber.length < 6 || !/^[A-Z]{2}$/.test(countryCode)) return json({ error: 'Complète ton profil avec ton prénom, ton nom et ton téléphone avant de payer.' }, 400);
    try {
      const customerIp = String(request.headers.get('cf-connecting-ip') || '').trim();
      const checkoutBody = { product_id: productId, email, first_name: firstName, last_name: lastName, phone: { number: phoneNumber, country_code: countryCode }, redirect_url: 'https://huggy.fun/?checkout=success&sale={sale_id}', custom_metadata: { session_id: sessionId, plan_slug: planSlug, billing_cycle: billing } };
      if (customerIp) checkoutBody.customer_ip = customerIp;
      const result = await chariowRequest(env, '/checkout', { method: 'POST', body: JSON.stringify(checkoutBody) });
      const checkoutUrl = result.data?.payment?.checkout_url || result.data?.checkout_url || null;
      const step = String(result.data?.step || 'payment');
      const saleId = String(result.data?.purchase?.id || result.data?.sale?.id || '').trim();
      if (step === 'payment' && !checkoutUrl) throw new Error('Lien de paiement indisponible.');
      if (step !== 'payment') throw new Error(result.data?.message || 'Ce produit ne peut pas ouvrir un nouveau paiement.');
      const pending = await saveCheckoutSubscription(env, { session_id: sessionId, plan_slug: planSlug, billing_cycle: billing, status: 'pending_checkout', provider: 'chariow', provider_product_id: productId, provider_sale_id: saleId || null, provider_license_id: null, license_status: null, license_expires_at: null, current_period_start: null, current_period_end: null, customer_email: email });
      if (env.SUPABASE_URL && !pending) throw new Error('Impossible d’enregistrer la commande.');
      return json({ checkoutUrl, step, customerEmail: email });
    } catch (error) { return json({ error: error.message || 'Impossible de préparer le paiement.' }, 502); }
  }

  return json({ error: 'Route API introuvable.' }, 404);
}

export { BILLING_CATALOG, PLAN_CATALOG, planForProduct, verifyChariowSignature };
