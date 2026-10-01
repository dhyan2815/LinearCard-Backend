import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function testLocations() {
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

  const classId = '3388000000023199292.dev_bistro_cafe_gift_card_member';

  console.log('Testing patching merchantLocations...');
  const patchPayload1 = {
    merchantLocations: [
      { latitude: 23.109157, longitude: 72.603439 }
    ]
  };

  try {
    const res1 = await walletobjects.genericclass.patch({
      resourceId: classId,
      requestBody: patchPayload1,
    });
    console.log('Response with merchantLocations:');
    console.log(JSON.stringify({
      merchantLocations: res1.data.merchantLocations,
      locations: res1.data.locations,
    }, null, 2));
  } catch (err: any) {
    console.error('Error 1:', err.message);
  }

  console.log('\nTesting patching locations...');
  const patchPayload2 = {
    locations: [
      { kind: 'walletobjects#latLongPoint', latitude: 23.109157, longitude: 72.603439 }
    ]
  };

  try {
    const res2 = await walletobjects.genericclass.patch({
      resourceId: classId,
      requestBody: patchPayload2,
    });
    console.log('Response with locations:');
    console.log(JSON.stringify({
      merchantLocations: res2.data.merchantLocations,
      locations: res2.data.locations,
    }, null, 2));
  } catch (err: any) {
    console.error('Error 2:', err.message);
  }
}

testLocations();
