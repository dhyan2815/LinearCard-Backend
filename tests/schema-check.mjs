import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function assertTableExists(tableName) {
  const { error } = await supabase.from(tableName).select('id').limit(1);
  if (error && (error.code === '42P01' || error.code === 'PGRST205')) {
    throw new Error(`Table ${tableName} does not exist`);
  }
  if (error) {
    throw new Error(`Table ${tableName} query error: ${error.message} (${error.code})`);
  }
}

async function run() {
  try {
    await assertTableExists('PassTemplate');
    await assertTableExists('AuditLog');
    await assertTableExists('NotificationLog');
    const { error } = await supabase.from('Tenant').select('webhookUrl').limit(1);
    if (error && (error.code === '42703' || error.code === 'PGRST204')) {
      throw new Error('Tenant.webhookUrl does not exist');
    }
    if (error) {
      throw new Error(`Tenant.webhookUrl query error: ${error.message} (${error.code})`);
    }
    console.log('All schema checks pass.');
  } catch (err) {
    console.error('Schema check failed:', err.message);
    process.exit(1);
  }
}
run();
