/**
 * Phase 6.5 — `npm run demo:reset`: wipe and reseed the demo brands.
 *
 * Read this before running it. Local, preview and production share ONE
 * Supabase project (D13), so this script runs against production data from
 * whatever machine you launch it on. That is why it:
 *
 *   - refuses to do anything without an explicit tenant-ID allowlist (0.2b),
 *   - refuses to run without `--yes`,
 *   - never truncates a table and never deletes "where tenantId != x" —
 *     every delete is `.eq('tenantId', <an id you listed>)`,
 *   - touches no tenant you did not name, even by accident.
 *
 * Usage:
 *   npm run demo:reset -w apps/api -- --tenant=<uuid> [--tenant=<uuid>] --yes
 *   DEMO_TENANT_IDS=<uuid>,<uuid> npm run demo:reset -w apps/api -- --yes
 *
 * Add `--members=8` to change how many demo members each tenant gets.
 */
import '../src/env';
import { createClient } from '@supabase/supabase-js';
import { PROGRAM_PRESETS, slugify } from '../src/programs/presets';
import { buildClassSuffix } from '../src/wallet/wallet.service';

/** Which presets a reset brand comes back with. Loyalty first (D14). */
const SEED_PRESET_IDS = ['coffee_loyalty', 'event_ticket'];

/** Tables holding rows owned by a tenant, in FK-safe deletion order. */
const TENANT_SCOPED_TABLES = [
  'NotificationLog',
  'ConsentLog',
  'AuditLog',
  'PaymentEvent',
  'Campaign',
  'Pass',
  'Member',
  'Tier',
  'PassTemplate',
  'Program',
];

const FIRST_NAMES = [
  'Aarav',
  'Diya',
  'Kabir',
  'Meera',
  'Rohan',
  'Ananya',
  'Vikram',
  'Ishita',
];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=');
}

function die(message: string): never {
  console.error(`\n[demo:reset] ${message}\n`);
  process.exit(1);
}

async function main() {
  const allowlist = [
    ...process.argv
      .filter((a) => a.startsWith('--tenant='))
      .map((a) => a.split('=')[1]),
    ...(process.env.DEMO_TENANT_IDS || '').split(','),
  ]
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowlist.length === 0) {
    die(
      'No tenant allowlist. This script deletes data from the shared ' +
        '(production) Supabase project, so it will only ever touch tenants ' +
        'you name explicitly.\n' +
        '  npm run demo:reset -w apps/api -- --tenant=<uuid> --yes',
    );
  }
  if (!process.argv.includes('--yes')) {
    die(
      `Refusing to run without --yes. This would delete every member, pass, ` +
        `consent record and notification of ${allowlist.length} tenant(s).`,
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    die('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.');

  const db = createClient(url!, key!, {
    auth: { persistSession: false },
  });
  const memberCount = Number(arg('members') || 6);
  const projectRef = url!.match(/https?:\/\/([^.]+)\./)?.[1] || url!;

  console.log(`\n[demo:reset] Supabase project: ${projectRef}`);
  console.log(`[demo:reset] Tenants: ${allowlist.join(', ')}\n`);

  for (const tenantId of allowlist) {
    const { data: tenant } = await db
      .from('Tenant')
      .select('id, name, classSuffix, brandHexColor, logoUrl, heroUrl')
      .eq('id', tenantId)
      .maybeSingle();

    if (!tenant) {
      // Not fatal — a stale id in the allowlist must not stop the others,
      // but it must never be silently treated as "nothing to do".
      console.warn(`  ! ${tenantId}: no such tenant, skipped`);
      continue;
    }

    console.log(`  ${tenant.name} (${tenantId})`);

    for (const table of TENANT_SCOPED_TABLES) {
      // Tier has no tenantId of its own — it hangs off Program.
      if (table === 'Tier') {
        const { data: programs } = await db
          .from('Program')
          .select('id')
          .eq('tenantId', tenantId);
        const ids = (programs || []).map((p: any) => p.id);
        if (ids.length) await db.from('Tier').delete().in('programId', ids);
        continue;
      }
      const { error } = await db.from(table).delete().eq('tenantId', tenantId);
      // A table that doesn't exist in this schema yet is not an error worth
      // aborting a reseed for; anything else is.
      if (error && !/does not exist/i.test(error.message)) {
        die(`Failed clearing ${table} for ${tenantId}: ${error.message}`);
      }
    }
    console.log(`    cleared ${TENANT_SCOPED_TABLES.length} tables`);

    const tenantSlug = tenant.classSuffix || slugify(tenant.name || 'tenant');

    for (const presetId of SEED_PRESET_IDS) {
      const preset = PROGRAM_PRESETS.find((p) => p.id === presetId);
      if (!preset) die(`Unknown preset '${presetId}'`);

      const enrollmentSlug = slugify(preset!.name);
      const { data: program, error: programError } = await db
        .from('Program')
        .insert({
          tenantId,
          name: preset!.name,
          kind: preset!.kind,
          archetype: preset!.archetype,
          status: 'draft',
          enrollmentSlug,
          earnRate: preset!.loyalty?.earnRate ?? null,
          redeemRate: preset!.loyalty?.redeemRate ?? null,
          redeemCapPercent: preset!.loyalty?.redeemCapPercent ?? null,
        })
        .select()
        .single();
      if (programError || !program)
        die(`Failed creating program: ${programError?.message}`);

      const specs = preset!.tiers.length
        ? preset!.tiers.map((t) => t.name)
        : [undefined];
      const { data: templates, error: templateError } = await db
        .from('PassTemplate')
        .insert(
          specs.map((tierName) => ({
            tenantId,
            programId: program!.id,
            archetype: preset!.archetype,
            status: 'draft',
            title: tierName ? `${preset!.name} — ${tierName}` : preset!.name,
            subtitle: preset!.name,
            fieldRows: preset!.fieldRows,
            hexBackgroundColor: preset!.hexBackgroundColor,
            logoUrl: tenant.logoUrl ?? null,
            heroImageUrl: tenant.heroUrl ?? null,
            earnRate: preset!.loyalty?.earnRate ?? 0.1,
            redeemRate: preset!.loyalty?.redeemRate ?? 1,
            redeemCapPercent: preset!.loyalty?.redeemCapPercent ?? 50,
            classSuffix: buildClassSuffix(
              tenantSlug,
              enrollmentSlug,
              tierName,
            ),
          })),
        )
        .select();
      if (templateError) die(`Failed creating templates: ${templateError.message}`);

      if (preset!.tiers.length) {
        await db.from('Tier').insert(
          preset!.tiers.map((t, idx) => ({
            programId: program!.id,
            name: t.name,
            minPoints: t.minPoints,
            templateId: (templates || [])[idx]?.id ?? null,
            sortOrder: idx,
          })),
        );
      }

      console.log(
        `    seeded ${preset!.name} (${preset!.kind}, ${specs.length} template(s))`,
      );

      // Members and their history hang off the loyalty program only — a
      // ticket program has no points to give them.
      if (preset!.kind !== 'loyalty') continue;

      const tiers = preset!.tiers;
      for (let i = 0; i < memberCount; i++) {
        const balance = i * 120;
        const tier =
          [...tiers].reverse().find((t) => balance >= t.minPoints)?.name ??
          tiers[0]?.name ??
          'Standard';

        const { data: member } = await db
          .from('Member')
          .insert({
            tenantId,
            name: `${FIRST_NAMES[i % FIRST_NAMES.length]} (demo)`,
            // Reserved-for-fiction range, so a demo send can never reach a
            // real person's phone.
            phone: `+9199000${String(10000 + i).slice(-5)}`,
            isTestAccount: true,
          })
          .select()
          .single();
        if (!member) continue;

        await db.from('Pass').insert({
          tenantId,
          memberId: member.id,
          programId: program!.id,
          balance,
          tier,
          fullPassId: `demo.${program!.id}.${member.id}`,
        });

        await db.from('AuditLog').insert({
          tenantId,
          memberId: member.id,
          actor: 'demo:reset',
          action: 'balance_adjusted',
          details: { amount: balance, reason: 'demo seed', newBalance: balance },
        });
      }
      console.log(`    seeded ${memberCount} demo members with history`);
    }
  }

  console.log('\n[demo:reset] done.\n');
}

main().catch((err) => die(err?.message || String(err)));
