import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleApi } from '../api.mjs';

const env = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  CHARIOW_API_KEY: 'chariow-test',
  CHARIOW_WEBHOOK_SECRET: 'whsec_huggy_test',
  CHARIOW_PRODUCT_STARTER_MONTHLY: 'prd_starter_monthly',
  CHARIOW_PRODUCT_STARTER_ANNUAL: 'prd_starter_annual',
  CHARIOW_PRODUCT_PRO_MONTHLY: 'prd_pro_monthly',
  CHARIOW_PRODUCT_PRO_ANNUAL: 'prd_pro_annual',
  CHARIOW_PRODUCT_BUSINESS_MONTHLY: 'prd_business_monthly',
  CHARIOW_PRODUCT_BUSINESS_ANNUAL: 'prd_business_annual',
};

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'client@example.com',
  user_metadata: { first_name: 'Awa', last_name: 'Diallo', phone: '+2250700000000', country_code: 'CI' },
};
const subscriptions = [];
const deliveries = [];
let nextSubscription = 1;

function reply(data, status = 200, headers = {}) {
  return new Response(data === null ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function eq(search, key) {
  const value = search.get(key);
  return value?.startsWith('eq.') ? decodeURIComponent(value.slice(3)) : null;
}

function matchingSubscription(search) {
  return subscriptions.filter(row => ['id', 'session_id', 'plan_slug', 'billing_cycle', 'status', 'provider_sale_id', 'provider_license_id', 'customer_email'].every(key => {
    const expected = eq(search, key);
    return expected === null || String(row[key] ?? '') === expected;
  }));
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const method = String(options.method || 'GET').toUpperCase();
  if (url.origin === 'https://supabase.test' && url.pathname === '/auth/v1/user') return reply(user);
  if (url.origin === 'https://api.chariow.com' && url.pathname === '/v1/checkout') {
    const body = JSON.parse(options.body);
    assert.equal(body.custom_metadata.session_id, user.id);
    assert.equal(body.redirect_url, 'https://huggy.fun/?checkout=success&sale={sale_id}');
    return reply({ data: { step: 'payment', purchase: { id: 'sal_huggy_1' }, payment: { checkout_url: 'https://payment.chariow.com/checkout?token=huggy' } } });
  }
  if (url.origin === 'https://supabase.test' && url.pathname === '/rest/v1/subscriptions') {
    if (method === 'GET') return reply(matchingSubscription(url.searchParams).slice(0, 1));
    if (method === 'POST') {
      const row = { id: `sub_${nextSubscription++}`, ...JSON.parse(options.body), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      subscriptions.push(row);
      return reply([row], 201);
    }
    if (method === 'PATCH') {
      const changes = JSON.parse(options.body);
      matchingSubscription(url.searchParams).forEach(row => Object.assign(row, changes));
      return reply(null, 204);
    }
  }
  if (url.origin === 'https://supabase.test' && url.pathname === '/rest/v1/billing_webhook_events') {
    if (method === 'POST') {
      const row = JSON.parse(options.body);
      if (deliveries.some(item => item.delivery_id === row.delivery_id)) return reply({ message: 'duplicate' }, 409);
      deliveries.push({ ...row, processed_at: null, processing_error: null });
      return reply(null, 201);
    }
    if (method === 'GET') return reply(deliveries.filter(row => row.delivery_id === eq(url.searchParams, 'delivery_id')).slice(0, 1));
    if (method === 'PATCH') {
      const changes = JSON.parse(options.body);
      deliveries.filter(row => row.delivery_id === eq(url.searchParams, 'delivery_id')).forEach(row => Object.assign(row, changes));
      return reply(null, 204);
    }
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
};

try {
  const checkout = await handleApi(new Request('https://huggy.fun/api/checkout', {
    method: 'POST',
    headers: { authorization: 'Bearer test-user', 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
    body: JSON.stringify({ plan: 'starter', billing: 'monthly' }),
  }), env);
  assert.equal(checkout.status, 200);
  assert.equal((await checkout.json()).checkoutUrl, 'https://payment.chariow.com/checkout?token=huggy');
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].provider_sale_id, 'sal_huggy_1');
  assert.equal(subscriptions[0].status, 'pending_checkout');

  const payload = JSON.stringify({
    event: 'successful.sale',
    sale: { id: 'sal_huggy_1', status: 'completed', custom_metadata: { session_id: user.id, plan_slug: 'starter', billing_cycle: 'monthly' } },
    product: { id: 'prd_starter_monthly' },
    customer: { email: user.email },
  });
  const signature = `sha256=${createHmac('sha256', env.CHARIOW_WEBHOOK_SECRET).update(payload).digest('hex')}`;
  const webhook = await handleApi(new Request('https://huggy.fun/api/webhooks/chariow', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chariow-signature': signature, 'x-pulse-delivery-id': 'delivery_huggy_1', 'x-pulse-event': 'successful.sale' },
    body: payload,
  }), env);
  assert.equal(webhook.status, 200);
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].status, 'active');
  assert.ok(subscriptions[0].current_period_end);
  assert.ok(deliveries[0].processed_at);

  const duplicate = await handleApi(new Request('https://huggy.fun/api/webhooks/chariow', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chariow-signature': signature, 'x-pulse-delivery-id': 'delivery_huggy_1' },
    body: payload,
  }), env);
  assert.deepEqual(await duplicate.json(), { ok: true, duplicate: true });

  const testPayload = JSON.stringify({ event: 'successful.sale', note: 'This is a test pulse', product: { id: 'prd_starter_monthly' }, customer: { email: user.email } });
  const testSignature = `sha256=${createHmac('sha256', env.CHARIOW_WEBHOOK_SECRET).update(testPayload).digest('hex')}`;
  const testPulse = await handleApi(new Request('https://huggy.fun/api/webhooks/chariow', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-chariow-signature': testSignature, 'x-pulse-delivery-id': 'delivery_huggy_test' }, body: testPayload,
  }), env);
  assert.deepEqual(await testPulse.json(), { ok: true, test: true });
  assert.equal(subscriptions.length, 1);
  assert.ok(deliveries.find(item => item.delivery_id === 'delivery_huggy_test')?.processed_at);

  console.log('Billing test passed: checkout, sale reconciliation, idempotency and test pulses are safe.');
} finally {
  globalThis.fetch = originalFetch;
}
