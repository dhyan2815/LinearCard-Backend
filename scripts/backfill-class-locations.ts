import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

// Load env vars from the nearest .env file
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in environment.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function backfillClassLocations() {
  let rawKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim() || '';
  if (
    rawKey &&
    !rawKey.includes('BEGIN PRIVATE KEY') &&
    !rawKey.includes('BEGIN RSA PRIVATE KEY')
  ) {
    rawKey = `-----BEGIN PRIVATE KEY-----\n${rawKey}\n-----END PRIVATE KEY-----\n`;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: rawKey,
    },
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });

  const walletobjects = google.walletobjects({ version: 'v1', auth });
  
  // We want to run for all active prefixes, or whatever WALLET_ENV_PREFIX says
  // For safety, let's just run for the resolved prefix in the current .env.
  // Wait, user asked to "let it run for every single prefixed env active".
  // The prefixes are 'dev_', 'preview_', and '' (production).
  const envPrefixes = ['dev_', 'preview_', ''];
  const issuerId = process.env.ISSUER_ID;

  if (!issuerId) {
    console.error('Missing ISSUER_ID in environment.');
    process.exit(1);
  }

  console.log(`Starting backfill for all programs that have locations...`);

  // We read the storeLocations from Program if they exist, or from PassTemplate as fallback?
  // Since we just migrated, we should read from Program, but the data might not be applied yet locally.
  // Actually, we can just query PassTemplate grouped by programId where storeLocations is set.
  // Wait, let's just query Program since we created a migration. But if the script runs before migration, it would fail.
  // Let's query PassTemplate for safety.
  
  const { data: templates, error } = await supabase
    .from('PassTemplate')
    .select('programId, classSuffix, storeLocations, status')
    .eq('status', 'published')
    .not('storeLocations', 'is', null);

  if (error || !templates) {
    console.error('Failed to fetch templates:', error);
    return;
  }

  const templatesWithLocs = templates.filter(t => t.storeLocations && t.storeLocations.length > 0);
  
  const programLocs = new Map<string, any[]>();
  for (const t of templatesWithLocs) {
    if (t.programId && !programLocs.has(t.programId)) {
      programLocs.set(t.programId, t.storeLocations);
    }
  }

  console.log(`Found ${programLocs.size} programs with locations to backfill.`);

  const { data: allTemplates } = await supabase
    .from('PassTemplate')
    .select('programId, classSuffix, googleClassIds');

  if (!allTemplates) {
    console.log('Failed to fetch all templates');
    return;
  }

  for (const [programId, storeLocations] of programLocs.entries()) {
    console.log(`\nBackfilling program ${programId} with ${storeLocations.length} locations...`);
    const siblingTemplates = allTemplates.filter(t => t.programId === programId && t.classSuffix);

    for (const template of siblingTemplates) {
      for (const prefix of envPrefixes) {
        // Only patch if the class was actually created for this env (checked via googleClassIds map)
        const envKey = prefix === '' ? 'prod' : prefix.replace('_', '');
        const hasClassForEnv = template.googleClassIds && template.googleClassIds[envKey];
        
        if (!hasClassForEnv) {
           continue;
        }
        
        const fullClassId = `${issuerId}.${prefix}${template.classSuffix}`;
        
        const merchantLocations = storeLocations.slice(0, 10).map((l: any) => ({
          latitude: Number(l.latitude),
          longitude: Number(l.longitude),
        }));

        const patchPayload = { merchantLocations };

        try {
          await walletobjects.genericclass.patch({
            resourceId: fullClassId,
            requestBody: patchPayload,
          });
          console.log(`  [PATCHED] ${fullClassId}`);
        } catch (err: any) {
          if (err.response?.status === 404) {
            console.log(`  [SKIPPED] ${fullClassId} (Not Found on Google Wallet)`);
          } else {
            console.error(`  [ERROR] ${fullClassId}: ${err.message}`);
          }
        }
      }
    }
  }

  console.log('\nBackfill complete.');
}

backfillClassLocations();
