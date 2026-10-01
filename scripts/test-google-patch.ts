import { google } from 'googleapis';
import * as path from 'path';

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function run() {
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
  
  const classId = `${process.env.ISSUER_ID}.dev_bistro_cafe_gift_card_member`;
  console.log(`Testing with class ID: ${classId}`);

  try {
    const patchPayload = {
      merchantLocations: [
        { latitude: 23.109157, longitude: 72.603439 },
        { latitude: 23.198233, longitude: 72.614922 }
      ]
    };

    console.log('Sending PATCH with:');
    console.log(JSON.stringify(patchPayload, null, 2));

    const response = await walletobjects.genericclass.patch({
      resourceId: classId,
      requestBody: patchPayload,
    });

    console.log('PATCH response merchantLocations:');
    console.log(JSON.stringify(response.data.merchantLocations, null, 2));
  } catch (err: any) {
    console.error('Error:', err.response?.data || err.message);
  }
}

run();
