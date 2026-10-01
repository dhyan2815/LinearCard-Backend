/**
 * Prints the raw Google Wallet JSON for a pass class and every pass object
 * issued under it. Nothing else goes to stdout, so it can be piped (| jq).
 *
 * Proximity notifications are driven by `merchantLocations` on the class (and
 * optionally on each object); this shows what Google actually holds.
 *
 *   npx tsx scripts/verify-class-locations.ts <class>
 *   npx tsx scripts/verify-class-locations.ts <class> --type generic
 *   npx tsx scripts/verify-class-locations.ts <class> --sync-object-locations   (WRITES)
 *
 * <class>: bare suffix, env-prefixed (dev_…) or full id (<issuer>.dev_…).
 * --sync-object-locations copies the class's merchantLocations onto every
 * ACTIVE object.
 *
 * Output: the class JSON, then each object JSON, separated by a blank line.
 * Fields to look at: class `merchantLocations`; object `state` (only "active"
 * notifies), `classId`, and optional own `merchantLocations`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { google } from 'googleapis';

// Same load order as the API: the first file that defines a var wins.
for (const envFile of ['.env']) {
  const envPath = path.resolve(process.cwd(), envFile);
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath, quiet: true });
}

/** Google has one class/object REST resource per wallet type. */
const WALLET_TYPES = {
  loyalty: { classApi: 'loyaltyclass', objectApi: 'loyaltyobject' },
  generic: { classApi: 'genericclass', objectApi: 'genericobject' },
  giftcard: { classApi: 'giftcardclass', objectApi: 'giftcardobject' },
  offer: { classApi: 'offerclass', objectApi: 'offerobject' },
  eventticket: { classApi: 'eventticketclass', objectApi: 'eventticketobject' },
} as const;

type WalletTypeKey = keyof typeof WALLET_TYPES;

const OBJECT_PAGE_SIZE = 20;

/** Authenticated Google Wallet client using the service account from .env. */
function createWalletClient(): any {
  let privateKey = (process.env.GOOGLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
  // .env keys are sometimes stored without the PEM header/footer.
  if (privateKey && !privateKey.includes('PRIVATE KEY')) {
    privateKey = `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----\n`;
  }
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: process.env.GOOGLE_CLIENT_EMAIL, private_key: privateKey },
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });
  return google.walletobjects({ version: 'v1', auth });
}

/**
 * Class ids are `${issuerId}.${envPrefix}_${suffix}`. Turns the CLI argument
 * into the full id(s) worth trying, in order.
 */
function resolveClassIds(input: string): string[] {
  const issuerId = process.env.ISSUER_ID;
  if (/^\d+\..+/.test(input)) return [input];
  if (/^(dev|preview|prod)_/.test(input)) return [issuerId ? `${issuerId}.${input}` : input];
  if (!issuerId) return [input];

  const explicit = process.env.WALLET_ENV_PREFIX?.trim();
  const envPrefix = explicit
    ? explicit === 'none' ? '' : explicit
    : process.env.VERCEL_ENV === 'production' ? ''
    : process.env.VERCEL_ENV === 'preview' ? 'preview'
    : 'dev';
  return [envPrefix ? `${issuerId}.${envPrefix}_${input}` : '', `${issuerId}.${input}`].filter(Boolean);
}

/**
 * Fetches the class from Google. Its wallet type isn't known up front, so try
 * each type until one answers (a wrong type gives 400/404).
 */
async function fetchClass(wallet: any, classId: string, preferred?: WalletTypeKey) {
  const order = [
    ...(preferred ? [preferred] : []),
    ...(Object.keys(WALLET_TYPES) as WalletTypeKey[]).filter((k) => k !== preferred),
  ];
  for (const typeKey of order) {
    try {
      const res = await wallet[WALLET_TYPES[typeKey].classApi].get({ resourceId: classId });
      return { typeKey, classData: res.data };
    } catch (err: any) {
      const status = err.response?.status;
      if (status !== 400 && status !== 404) throw err; // auth/network problem: surface it
    }
  }
  return null;
}

const printJson = (payload: unknown) => console.log(JSON.stringify(payload, null, 2));

async function main() {
  const argv = process.argv.slice(2);
  const typeFlagAt = argv.indexOf('--type');
  const typeValueAt = typeFlagAt === -1 ? -1 : typeFlagAt + 1;
  const typeArg = typeFlagAt === -1 ? undefined : argv[typeValueAt]?.toLowerCase().replace('class', '');
  // The class arg is the first token that is neither a flag nor the --type value.
  const input = argv.find((a, i) => !a.startsWith('--') && i !== typeValueAt);

  if (!input || (typeArg && !(typeArg in WALLET_TYPES))) {
    console.error('usage: verify-class-locations.ts <class> [--type loyalty|generic|giftcard|offer|eventticket] [--sync-object-locations]');
    process.exit(1);
  }

  const wallet = createWalletClient();
  let found: Awaited<ReturnType<typeof fetchClass>> = null;
  let classId = '';
  for (classId of resolveClassIds(input)) {
    found = await fetchClass(wallet, classId, typeArg as WalletTypeKey | undefined);
    if (found) break;
  }
  if (!found) {
    console.error(`class not found: ${resolveClassIds(input).join(', ')}`);
    process.exit(1);
  }

  const { typeKey, classData } = found;
  const res = await wallet[WALLET_TYPES[typeKey].objectApi].list({ classId, maxResults: OBJECT_PAGE_SIZE });
  const objects: any[] = res.data.resources ?? [];
  if (res.data.pagination?.nextPageToken) {
    console.error(`warning: more than ${OBJECT_PAGE_SIZE} objects, showing the first page only`);
  }

  printJson(classData);
  for (const obj of objects) {
    console.log();
    printJson(obj);
  }

  if (argv.includes('--sync-object-locations')) {
    for (const obj of objects.filter((o) => o.state === 'active')) {
      const patched = await wallet[WALLET_TYPES[typeKey].objectApi].patch({
        resourceId: obj.id,
        requestBody: { merchantLocations: classData.merchantLocations },
      });
      console.error(`synced ${obj.id}: ${patched.data.merchantLocations?.length ?? 0} location(s)`);
    }
  }
}

main().catch((err) => {
  console.error(err.response?.data || err);
  process.exit(1);
});
