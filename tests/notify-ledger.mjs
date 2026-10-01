import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/** Implementation of logNotification matching lib/notify.ts */
async function logNotification({ supabase, tenantId, memberId, type, channel, status, errorReason }) {
  try {
    const { error } = await supabase.from('NotificationLog').insert({
      tenantId,
      memberId: memberId || null,
      type,
      channel,
      status,
      error: errorReason || null,
    });
    if (error) {
      console.error('[notify] Failed to write NotificationLog:', error);
    }
  } catch (err) {
    console.error('[notify] Failed to write NotificationLog:', err);
  }
}

async function test() {
  console.log('Testing NotificationLog ledger...');

  // 1. Fetch tenant
  const { data: tenants, error: tenantError } = await supabase.from('Tenant').select('id, name').limit(1);
  if (tenantError || !tenants?.length) throw new Error('No tenant found in database');
  const tenantId = tenants[0].id;

  // 2. Create mock member for FK constraint
  const testPhone = `+1999${Math.floor(1000000 + Math.random() * 9000000)}`;
  const { data: member, error: memberError } = await supabase
    .from('Member')
    .insert({ tenantId, phone: testPhone, name: 'Notification Test User' })
    .select('id')
    .single();
  if (memberError || !member) throw new Error(`FAIL inserting Member: ${memberError?.message}`);
  const memberId = member.id;

  try {
    // 3. Test insert sent notification log (pass_link via whatsapp)
    await logNotification({
      supabase,
      tenantId,
      memberId,
      type: 'pass_link',
      channel: 'whatsapp',
      status: 'sent',
    });

    // 4. Test insert sent notification log (receipt via whatsapp)
    await logNotification({
      supabase,
      tenantId,
      memberId,
      type: 'receipt',
      channel: 'whatsapp',
      status: 'sent',
    });

    // 5. Test insert sent notification log (balance_update via wallet_push)
    await logNotification({
      supabase,
      tenantId,
      memberId,
      type: 'balance_update',
      channel: 'wallet_push',
      status: 'sent',
    });

    // 6. Test insert failed notification log with errorReason
    const errorMsg = 'WAHA delivery failure: session disconnected';
    await logNotification({
      supabase,
      tenantId,
      memberId,
      type: 'pass_link',
      channel: 'whatsapp',
      status: 'failed',
      errorReason: errorMsg,
    });

    // 7. Test non-throwing safety on simulated DB rejection
    let didThrow = false;
    try {
      const failingSupabase = {
        from: () => ({
          insert: async () => { throw new Error('Simulated network failure'); }
        })
      };
      await logNotification({
        supabase: failingSupabase,
        tenantId,
        memberId,
        type: 'receipt',
        channel: 'whatsapp',
        status: 'failed',
      });
    } catch (e) {
      didThrow = true;
    }
    console.assert(!didThrow, 'FAIL: logNotification must never throw even if DB fails');
    console.log('✅ logNotification non-throwing safety verified');

    // 8. Query back the history to ensure correct count, ordering and data integrity
    const { data: memberLogs, error: queryError } = await supabase
      .from('NotificationLog')
      .select('*')
      .eq('memberId', memberId)
      .order('sentAt', { ascending: true });
    if (queryError) throw new Error(`FAIL querying member notification logs: ${queryError.message}`);
    console.assert(memberLogs.length === 4, `FAIL: expected 4 logs for member, got ${memberLogs?.length}`);

    const [log1, log2, log3, log4] = memberLogs;
    console.assert(log1.channel === 'whatsapp' && log1.type === 'pass_link' && log1.status === 'sent' && log1.error === null, 'FAIL: log1 mismatch');
    console.assert(log2.channel === 'whatsapp' && log2.type === 'receipt' && log2.status === 'sent' && log2.error === null, 'FAIL: log2 mismatch');
    console.assert(log3.channel === 'wallet_push' && log3.type === 'balance_update' && log3.status === 'sent' && log3.error === null, 'FAIL: log3 mismatch');
    console.assert(log4.channel === 'whatsapp' && log4.type === 'pass_link' && log4.status === 'failed' && log4.error === errorMsg, 'FAIL: log4 mismatch');
    console.log(`✅ Queried and verified ${memberLogs.length} logged deliveries for member`);

    // Cleanup logs
    await supabase.from('NotificationLog').delete().eq('memberId', memberId);
    console.log('✅ Cleaned up test notification logs');
  } finally {
    // 9. Cleanup member
    await supabase.from('Member').delete().eq('id', memberId);
    console.log('✅ Cleaned up test member');
  }

  console.log('All NotificationLog ledger tests pass.');
}

test().catch(e => {
  console.error('Test execution failed:', e.message);
  process.exit(1);
});
