/**
 * Verifies the Google Wallet preview card renders the same field order and
 * values that `WalletService` writes into the live GenericObject.
 *
 * Reference layout (developers.google.com/wallet/generic/resources/brand-guidelines):
 *   logo + cardTitle (one row) → subheader → header → barcode + alternateText
 *   → heroImage → textModulesData details
 *
 * Usage (headed Chrome, dev servers already up):
 *   node scripts/verify-wallet-preview.mjs <programId>
 *
 * Mints a local admin_session from JWT_SECRET so it does not need the OTP flow.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';

const programId = process.argv[2];
if (!programId) throw new Error('usage: node scripts/verify-wallet-preview.mjs <programId>');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data: admins } = await supabase.from('Admin').select('id, tenantId').limit(1);
const admin = admins?.[0];
if (!admin) throw new Error('no Admin row to impersonate');

const token = jwt.sign(
  { adminId: admin.id, tenantId: admin.tenantId, role: 'owner' },
  process.env.JWT_SECRET,
  { expiresIn: '1d' },
);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
await context.addCookies([
  { name: 'admin_session', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' },
]);

const page = await context.newPage();
await page.goto(`http://localhost:3000/dashboard/programs/${programId}/design`);
await page.waitForSelector('text=Template Designer');
await page.waitForTimeout(2500);

const card = page.locator('.select-none').first();
await card.screenshot({ path: '.playwright-mcp/wallet-preview.png' });

const layout = await card.evaluate((el) => {
  const box = (node) => (node ? node.getBoundingClientRect().top : null);
  const texts = [...el.querySelectorAll('span')].map((s) => ({ text: s.textContent.trim(), top: box(s) }));
  return {
    texts: texts.filter((t) => t.text),
    // Detail rows render as <input> when the designer passes setDesignData,
    // so they are tracked separately from the plain <span> header texts.
    detailTops: [...el.querySelectorAll('input')].map(box),
    logoTop: box(el.querySelector('img[alt="Logo"]')),
    qrTop: box(el.querySelector('svg')),
    heroTop: box(el.querySelector('img[alt="Hero"]')),
  };
});

const find = (re) => layout.texts.find((t) => re.test(t.text));
const cardTitle = layout.texts[0];
const header = find(/Dhyan Patel|Live Pass/);
const caption = find(/ • /);

const checks = [
  ['cardTitle sits on the logo row', Math.abs(cardTitle.top - layout.logoTop) < 24],
  ['header (member name) is above the barcode', header.top < layout.qrTop],
  ['barcode caption renders alternateText, not the pass id', !!caption && !/882190/.test(caption.text)],
  ['hero image sits below the barcode', layout.heroTop === null || layout.heroTop > layout.qrTop],
  ['details rows sit below the hero image',
    layout.heroTop === null ||
      [...layout.detailTops, ...layout.texts.map((t) => t.top)].some((top) => top > layout.heroTop)],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log('\nscreenshot: .playwright-mcp/wallet-preview.png');

await browser.close();
process.exit(failed ? 1 : 0);
