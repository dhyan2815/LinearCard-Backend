import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { TemplatesService } from '../src/templates/templates.service';
import { SupabaseService } from '../src/supabase/supabase.service';

/**
 * One-off retroactive fix for WAL-10/WAL-11: pushes the corrected
 * "tenant · program" brand title and each template's real fieldRows onto
 * every already-issued pass. Run once after deploying the code fix and after
 * scripts nothing here changes the class itself — run
 * `templates/:id/publish` for each row first (see the implementation plan's
 * Task 8) or this will resync objects against a class whose issuerName is
 * still stale.
 *
 * Usage: npx ts-node scripts/resync-all-published-templates.ts [--dry-run]
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const app = await NestFactory.createApplicationContext(AppModule);
  const supabaseService = app.get(SupabaseService);
  const templatesService = app.get(TemplatesService);

  const { data: templates, error } = await supabaseService.client
    .from('PassTemplate')
    .select('id, tenantId, title')
    .eq('status', 'published');
  if (error) throw error;

  console.log(`Found ${templates?.length ?? 0} published templates.`);

  for (const template of templates ?? []) {
    if (dryRun) {
      console.log(`[dry-run] would resync template ${template.id} (${template.title}) for tenant ${template.tenantId}`);
      continue;
    }
    try {
      const result = await templatesService.resyncPasses(template.tenantId, template.id);
      console.log(
        `Resynced template ${template.id} (${template.title}): ${result.succeeded}/${result.total} passes updated, ${result.failed} failed.`,
      );
    } catch (err: any) {
      console.error(`Failed to resync template ${template.id}: ${err.message}`);
    }
  }

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
