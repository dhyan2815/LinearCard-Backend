// tests/dashboard-stats.mjs
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-demo-key';
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function test() {
  console.log(`Connecting to ${BASE_URL}...`);

  // 1. GET /api/dashboard/stats
  const statsRes = await fetch(`${BASE_URL}/api/dashboard/stats`);
  const data = await statsRes.json();
  console.assert(data.success,                   `FAIL: ${JSON.stringify(data)}`);
  console.assert('memberCount'      in data,     'FAIL: memberCount missing');
  console.assert('passCount'        in data,     'FAIL: passCount missing');
  console.assert('walletStatus'     in data,     'FAIL: walletStatus missing');
  console.assert('tierDistribution' in data,     'FAIL: tierDistribution missing — new field');
  console.assert('google' in data.walletStatus,  'FAIL: walletStatus.google missing');
  console.assert('apple' in data.walletStatus,   'FAIL: walletStatus.apple missing');
  console.assert('samsung' in data.walletStatus, 'FAIL: walletStatus.samsung missing');
  console.assert(typeof data.tierDistribution === 'object', 'FAIL: tierDistribution must be an object');
  console.log('✅ GET /api/dashboard/stats');

  // Fetch tenant for settings test
  const { data: tenants, error: tenantError } = await supabase.from('Tenant').select('id, webhookUrl').limit(1);
  if (tenantError || !tenants?.length) throw new Error('No tenant found in database');
  const tenantId = tenants[0].id;
  const originalWebhook = tenants[0].webhookUrl;

  // 2. GET /api/settings - Unauthorized without cookie
  const unauthGetRes = await fetch(`${BASE_URL}/api/settings`);
  console.assert(unauthGetRes.status === 401, `FAIL: expected 401 for unauthorized GET /api/settings, got ${unauthGetRes.status}`);
  console.log('✅ 401 Unauthorized for GET /api/settings without cookie');

  // 3. GET /api/settings - Authorized with cookie
  const adminToken = jwt.sign({ adminId: 'test-admin', tenantId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
  const authHeaders = {
    'Content-Type': 'application/json',
    'Cookie': `admin_session=${adminToken}`,
  };

  const authGetRes = await fetch(`${BASE_URL}/api/settings`, { headers: authHeaders });
  const authGetData = await authGetRes.json();
  console.assert(authGetData.success, `FAIL GET /api/settings: ${JSON.stringify(authGetData)}`);
  console.assert(authGetData.tenant.id === tenantId, 'FAIL: tenant id mismatch');
  console.assert('apiKey' in authGetData.tenant, 'FAIL: apiKey missing from tenant settings');
  console.assert('webhookUrl' in authGetData.tenant, 'FAIL: webhookUrl missing from tenant settings');
  console.log('✅ GET /api/settings with admin auth');

  // 4. PATCH /api/settings - Unauthorized without cookie
  const unauthPatchRes = await fetch(`${BASE_URL}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookUrl: 'https://example.com/webhook' }),
  });
  console.assert(unauthPatchRes.status === 401, `FAIL: expected 401 for unauthorized PATCH /api/settings, got ${unauthPatchRes.status}`);
  console.log('✅ 401 Unauthorized for PATCH /api/settings without cookie');

  // 5. PATCH /api/settings - Invalid URL validation
  const badUrlRes = await fetch(`${BASE_URL}/api/settings`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ webhookUrl: 'invalid-url-schema' }),
  });
  console.assert(badUrlRes.status === 400, `FAIL: expected 400 for invalid webhookUrl, got ${badUrlRes.status}`);
  console.log('✅ 400 Bad Request for invalid webhookUrl');

  // 6. PATCH /api/settings - Empty update fields validation
  const emptyUpdateRes = await fetch(`${BASE_URL}/api/settings`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  console.assert(emptyUpdateRes.status === 400, `FAIL: expected 400 for empty update body, got ${emptyUpdateRes.status}`);
  console.log('✅ 400 Bad Request for empty update payload');

  // 7. PATCH /api/settings - Successful update
  try {
    const testWebhook = 'https://linearcard-test.example.com/webhook';
    const patchRes = await fetch(`${BASE_URL}/api/settings`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ webhookUrl: testWebhook }),
    });
    const patchData = await patchRes.json();
    console.assert(patchData.success, `FAIL PATCH /api/settings: ${JSON.stringify(patchData)}`);

    // Verify in DB / GET /api/settings
    const verifyGetRes = await fetch(`${BASE_URL}/api/settings`, { headers: authHeaders });
    const verifyGetData = await verifyGetRes.json();
    console.assert(verifyGetData.tenant.webhookUrl === testWebhook, `FAIL: webhookUrl not updated, got ${verifyGetData.tenant.webhookUrl}`);
    console.log('✅ PATCH /api/settings updated webhookUrl successfully');
  } finally {
    // Restore original webhookUrl
    await supabase.from('Tenant').update({ webhookUrl: originalWebhook }).eq('id', tenantId);
    console.log('✅ Cleaned up test webhookUrl');
  }

  console.log('Dashboard stats and settings tests pass.');
}

test().catch(e => {
  console.error(e.message);
  process.exit(1);
});
