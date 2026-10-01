// tests/notifications-api.mjs
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function test() {
  console.log(`Connecting to ${BASE_URL}...`);
  const { data: tenants, error: tenantError } = await supabase.from('Tenant').select('id').limit(1);
  if (tenantError || !tenants?.length) throw new Error('No tenant found in database');
  const tenantId = tenants[0].id;
  console.log(`Using tenantId: ${tenantId}`);

  // 1. GET /api/notifications/log
  const logRes = await fetch(`${BASE_URL}/api/notifications/log?tenantId=${tenantId}`);
  const logData = await logRes.json();
  console.assert(logData.success, `FAIL GET log: ${JSON.stringify(logData)}`);
  console.assert(Array.isArray(logData.logs), 'FAIL: logs must be an array');
  console.log('✅ GET /api/notifications/log');

  // 2. Channel validation: invalid channel 'email' should return 400
  const badRes = await fetch(`${BASE_URL}/api/notifications/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, channel: 'email', message: 'Test' }),
  });
  console.assert(badRes.status === 400, `FAIL: invalid channel should be 400, got ${badRes.status}`);
  console.log('✅ Channel validation');

  // 3. Message required: missing message should return 400
  const noMsgRes = await fetch(`${BASE_URL}/api/notifications/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, channel: 'wallet_push' }),
  });
  console.assert(noMsgRes.status === 400, `FAIL: missing message should be 400, got ${noMsgRes.status}`);
  console.log('✅ Message required');

  // 4. Missing tenantId should return 400 for send
  const noTenantRes = await fetch(`${BASE_URL}/api/notifications/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'whatsapp', message: 'Hello' }),
  });
  console.assert(noTenantRes.status === 400, `FAIL: missing tenantId should be 400, got ${noTenantRes.status}`);
  console.log('✅ Tenant required');

  // 5. Missing tenantId for GET /api/notifications/log should return 400
  const noTenantLogRes = await fetch(`${BASE_URL}/api/notifications/log`);
  console.assert(noTenantLogRes.status === 400, `FAIL: missing tenantId on log should be 400, got ${noTenantLogRes.status}`);
  console.log('✅ Tenant required for log query');

  // 6. Test Campaign Send & Logging with Temporary Member
  const testPhone = `+1999${Math.floor(1000000 + Math.random() * 9000000)}`;
  const { data: member, error: memberError } = await supabase
    .from('Member')
    .insert({ tenantId, phone: testPhone, name: 'Notification Campaign User' })
    .select('id')
    .single();
  if (memberError || !member) throw new Error(`FAIL creating test member: ${memberError?.message}`);

  try {
    const sendRes = await fetch(`${BASE_URL}/api/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        channel: 'whatsapp',
        message: 'Exclusive weekend reward points!',
      }),
    });
    const sendData = await sendRes.json();
    console.assert(sendData.success, `FAIL POST send: ${JSON.stringify(sendData)}`);
    console.assert(typeof sendData.sent === 'number', 'FAIL: sent count must be a number');
    console.assert(typeof sendData.failed === 'number', 'FAIL: failed count must be a number');
    console.log(`✅ POST /api/notifications/send (sent: ${sendData.sent}, failed: ${sendData.failed})`);

    // Verify logs include our campaign entry
    const postSendLogRes = await fetch(`${BASE_URL}/api/notifications/log?tenantId=${tenantId}&limit=10`);
    const postSendLogData = await postSendLogRes.json();
    console.assert(postSendLogData.success, 'FAIL: log fetch after send failed');
    const campaignLog = postSendLogData.logs.find(
      (l) => l.memberId === member.id && l.type === 'campaign' && l.channel === 'whatsapp'
    );
    console.assert(campaignLog !== undefined, 'FAIL: campaign notification log not found for member');
    console.log('✅ Campaign notification log verified in history');
  } finally {
    // Cleanup
    await supabase.from('NotificationLog').delete().eq('memberId', member.id);
    await supabase.from('Member').delete().eq('id', member.id);
    console.log('✅ Cleaned up campaign test data');
  }

  console.log('All notifications API tests pass.');
}

test().catch(e => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
