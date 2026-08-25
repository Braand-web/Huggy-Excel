const PLAN_CATALOG = [
  { slug: 'free', name: 'Free', monthlyPriceCents: 0, generationLimit: 3, model: 'anthropic/claude-sonnet-5', effort: 'low', features: ['3 générations par mois', 'Aperçu des classeurs', 'Exports limités'], sortOrder: 0 },
  { slug: 'starter', name: 'Starter', monthlyPriceCents: 990, generationLimit: 50, model: 'anthropic/claude-sonnet-5', effort: 'medium', features: ['50 générations par mois', 'Création et modification Excel', 'Exports CSV/XLSX'], sortOrder: 1 },
  { slug: 'pro', name: 'Pro', monthlyPriceCents: 2490, generationLimit: 250, model: 'anthropic/claude-sonnet-5', effort: 'high', features: ['250 générations par mois', 'Formules et tableaux avancés', '10 générations Opus incluses'], sortOrder: 2 },
  { slug: 'business', name: 'Business', monthlyPriceCents: 7900, generationLimit: 1000, model: 'anthropic/claude-opus-5', effort: 'high', features: ['1 000 générations par mois', 'Opus prioritaire', 'Support et espaces partagés'], sortOrder: 3 },
];

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
    await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify(row) });
  } catch { /* Persistence must not make a successful generation fail. */ }
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' } });
  if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, service: 'huggy-excel', provider: 'openrouter', configured: Boolean(env.OPENROUTER_API_KEY) });
  if (url.pathname === '/api/plans' && request.method === 'GET') {
    let plans = PLAN_CATALOG;
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      try { const response = await fetch(`${env.SUPABASE_URL}/rest/v1/plans?select=slug,name,monthly_price_cents,generation_limit,model,effort,features&active=eq.true&order=sort_order.asc`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }); if (response.ok) { const remote = await response.json(); if (remote.length) plans = remote.map(item => ({ ...item, monthlyPriceCents: item.monthly_price_cents, generationLimit: item.generation_limit })); } } catch { /* Use the checked-in catalog when Supabase is unavailable. */ }
    }
    return json({ plans });
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
    return json({ model: selection.model, effort: selection.effort, workbook: result.workbook, usage: result.usage });
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
