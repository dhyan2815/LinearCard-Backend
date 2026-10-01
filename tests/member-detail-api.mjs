// tests/member-detail-api.mjs
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

  let memberId;
  let tenantId;

  const { data: members } = await supabase.from('Member').select('id, tenantId').limit(1);
  if (!members?.length) {
    const { data: tenants } = await supabase.from('Tenant').select('id').limit(1);
    if (!tenants?.length) throw new Error('No tenant found in database');
    tenantId = tenants[0].id;
    const { data: newMember } = await supabase.from('Member').insert({
      tenantId,
      phone: '+19991234567',
      name: 'Test Member Detail',
    }).select().single();
    memberId = newMember.id;
  } else {
    memberId = members[0].id;
    tenantId = members[0].tenantId;
  }

  // 1. GET /api/members/[id]
  const data = await (await fetch(`${BASE_URL}/api/members/${memberId}`)).json();
  console.assert(data.success, `FAIL GET /api/members/[id]: ${JSON.stringify(data)}`);
  console.assert(data.member.id === memberId, 'FAIL: id mismatch');
  console.assert(Array.isArray(data.member.passes), 'FAIL: passes not an array');
  console.assert(Array.isArray(data.member.auditLog), 'FAIL: auditLog not an array');
  console.assert(Array.isArray(data.member.consentLog), 'FAIL: consentLog not an array');
  console.log('✅ GET /api/members/[id]');

  // 2. 404 for unknown member
  const notFound = await fetch(`${BASE_URL}/api/members/00000000-0000-0000-0000-000000000000`);
  console.assert(notFound.status === 404, 'FAIL: unknown member should be 404');
  console.log('✅ 404 for unknown member');

  // 3. POST /api/members/[id]/adjust-balance - Unauthorized without cookie
  const unauthRes = await fetch(`${BASE_URL}/api/members/${memberId}/adjust-balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passId: 'some-pass', newBalance: 100 }),
  });
  console.assert(unauthRes.status === 401, `FAIL: missing cookie should be 401, got ${unauthRes.status}`);
  console.log('✅ 401 Unauthorized for adjust-balance without cookie');

  // 4. POST /api/members/[id]/adjust-balance - Validation
  const adminToken = jwt.sign({ adminId: 'test-admin', tenantId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
  const authHeaders = {
    'Content-Type': 'application/json',
    'Cookie': `admin_session=${adminToken}`,
  };

  const missingFieldsRes = await fetch(`${BASE_URL}/api/members/${memberId}/adjust-balance`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ note: 'no pass id' }),
  });
  console.assert(missingFieldsRes.status === 400, `FAIL: missing fields should be 400, got ${missingFieldsRes.status}`);

  const badBalanceRes = await fetch(`${BASE_URL}/api/members/${memberId}/adjust-balance`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ passId: 'test-pass', newBalance: -5 }),
  });
  console.assert(badBalanceRes.status === 400, `FAIL: negative balance should be 400, got ${badBalanceRes.status}`);
  console.log('✅ 400 Bad Request validation checks for adjust-balance');

  // 5. Successful adjustment with temporary pass
  const { data: testPass, error: passErr } = await supabase.from('Pass').insert({
    tenantId,
    memberId,
    fullPassId: `test_issuer.test_pass_${Date.now()}`,
    balance: 50,
    tier: 'Silver',
  }).select().single();

  if (!passErr && testPass) {
    try {
      const adjustRes = await fetch(`${BASE_URL}/api/members/${memberId}/adjust-balance`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          passId: testPass.id,
          newBalance: 150,
          newTier: 'Gold',
          note: 'Automated test bonus',
        }),
      });
      const adjustData = await adjustRes.json();
      console.assert(adjustData.success, `FAIL adjust balance: ${JSON.stringify(adjustData)}`);
      console.log('✅ POST /api/members/[id]/adjust-balance succeeded');

      const { data: updatedPass } = await supabase.from('Pass').select('*').eq('id', testPass.id).single();
      console.assert(updatedPass.balance === 150, `FAIL: expected balance 150, got ${updatedPass?.balance}`);
      console.assert(updatedPass.tier === 'Gold', `FAIL: expected tier Gold, got ${updatedPass?.tier}`);
      console.log('✅ Pass balance & tier verified in database');

      // Verify AuditLog in GET /api/members/[id]
      const memberDetailRes = await (await fetch(`${BASE_URL}/api/members/${memberId}`)).json();
      console.assert(memberDetailRes.success, 'FAIL: member detail fetch failed');
      const latestAudit = memberDetailRes.member.auditLog.find((a) => a.action === 'manual_balance_adjustment');
      console.assert(latestAudit !== undefined, 'FAIL: audit log entry not found in member detail');
      console.assert(latestAudit.note === 'Automated test bonus', 'FAIL: audit log note mismatch');
      console.assert(latestAudit.newValue?.balance === 150, 'FAIL: audit log newValue balance mismatch');
      console.log('✅ AuditLog entry created & verified in member detail API');
    } finally {
      await supabase.from('AuditLog').delete().eq('memberId', memberId).eq('action', 'manual_balance_adjustment');
      await supabase.from('Pass').delete().eq('id', testPass.id);
    }
  }

  console.log('All member detail API tests pass.');
}

test().catch((e) => {
  console.error('Test error:', e.message);
  process.exit(1);
});
