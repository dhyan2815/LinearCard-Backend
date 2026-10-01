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

// We don't really need supabase for this script if we just pass class IDs as args,
// but it's here for consistency with other scripts if needed later.

async function repairCallbackUrl() {
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

  const issuerId = process.env.ISSUER_ID;
  const publicCallbackUrl = process.env.PUBLIC_CALLBACK_URL;
  const webhookSecret = process.env.WALLET_WEBHOOK_SECRET;

  if (!issuerId) {
    console.error('Missing ISSUER_ID in environment.');
    process.exit(1);
  }

  if (!publicCallbackUrl) {
    console.error('Missing PUBLIC_CALLBACK_URL in environment. You must set this to a valid HTTPS URL (e.g., ngrok tunnel) before running this script.');
    process.exit(1);
  }
  
  if (/localhost|127\.0\.0\.1/.test(publicCallbackUrl)) {
    console.error(`Refusing to use a localhost callback URL (${publicCallbackUrl}).`);
    process.exit(1);
  }

  const baseUrl = publicCallbackUrl.replace(/\/$/, '');
  const callbackUrl = `${baseUrl}/passes/webhooks/google-wallet${webhookSecret ? `/${webhookSecret}` : ''}`;
  
  const args = process.argv.slice(2);
  const classIdsToRepair = args.length > 0 ? args : ['dev_bistro_cafe_coffee_loyalty_silver'];

  console.log(`Resolved callback URL to patch: ${callbackUrl}`);
  console.log(`Starting callback URL repair for ${classIdsToRepair.length} classes...`);

  for (const classSuffix of classIdsToRepair) {
    // If they already passed the full issuerId.class format, use it directly
    const fullClassId = classSuffix.includes('.') 
      ? classSuffix 
      : `${issuerId}.${classSuffix}`;
    
    const patchPayload = {
      callbackOptions: {
        url: callbackUrl,
      }
    };

    try {
      await walletobjects.genericclass.patch({
        resourceId: fullClassId,
        requestBody: patchPayload,
      });
      console.log(`  [PATCHED] ${fullClassId} -> ${callbackUrl}`);
    } catch (err: any) {
      if (err.response?.status === 404) {
        console.log(`  [SKIPPED] ${fullClassId} (Not Found on Google Wallet)`);
      } else {
        console.error(`  [ERROR] ${fullClassId}: ${err.message}`);
      }
    }
  }

  console.log('\nRepair complete.');
}

repairCallbackUrl();
