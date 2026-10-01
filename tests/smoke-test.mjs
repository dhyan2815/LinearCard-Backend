#!/usr/bin/env node
// Run: node tests/smoke-test.mjs

const BASE = 'http://localhost:3000';

async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    console.log(`✅ PASS [${Date.now() - start}ms] ${name}`);
  } catch (e) {
    console.error(`❌ FAIL ${name}:`, e.message);
  }
}

await test('Health check: GET /api/generate-pass', async () => {
  const r = await fetch(`${BASE}/api/generate-pass`);
  const d = await r.json();
  if (!d.isConfigured) throw new Error('API not configured — check .env');
});

await test('Pass issuance: POST /api/generate-pass', async () => {
  const r = await fetch(`${BASE}/api/generate-pass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      memberName: 'Test Member', cardTitle: 'Smoke Test Pass',
      balance: '100 Pts', tier: 'Bronze', hexBackgroundColor: '#1A365D',
      barcodeValue: 'https://linearcard.vercel.app/test', barcodeAltText: 'TEST001'
    })
  });
  const d = await r.json();
  if (!d.success) throw new Error(d.error);
  if (!d.googleWalletUrl.startsWith('https://pay.google.com')) throw new Error('Invalid wallet URL');
  console.log(`   → Pass ID: ${d.passId}`);
  console.log(`   → URL: ${d.googleWalletUrl.substring(0, 60)}...`);
  global._testPassId = d.passId; // carry forward
});

if (global._testPassId) {
  await test('Live update: POST /api/update-pass (Expect offline)', async () => {
    const r = await fetch(`${BASE}/api/update-pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        passId: global._testPassId,
        balance: '50 Pts', tier: 'Silver',
        pushNotification: 'Smoke test: balance updated to 50 Pts'
      })
    });
    const d = await r.json();
    if (!d.success) {
      // It will likely throw a 500 or 404 with a not found message because the pass isn't saved yet
      if (r.status === 404 || (d.error && (d.error.includes('404') || d.error.includes('not found')))) {
        console.log(`   → Expected failure: Object not materialized on Google servers until user saves pass.`);
        return;
      }
      throw new Error(d.error);
    }
  });
}

await test('Pass validation: POST /api/validate-pass (Expect offline)', async () => {
  if (!global._testPassId) throw new Error('Skipped — no passId from issuance test');
  const r = await fetch(`${BASE}/api/validate-pass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passId: global._testPassId })
  });
  const d = await r.json();
  if (!d.valid) {
    if (r.status === 404 || (d.error && (d.error.includes('404') || d.error.includes('not found')))) {
      console.log(`   → Expected failure: Object not materialized on Google servers until user saves pass.`);
      return;
    }
    throw new Error(d.error || 'Pass not found or invalid');
  }
  console.log(`   → Member: ${d.memberName}, Balance: ${d.balance}`);
});
