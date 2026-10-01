import { createClient } from '@supabase/supabase-js';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { PROGRAM_PRESETS } from '../src/programs/presets';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in environment.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: tenants, error: tenantErr } = await supabase.from('Tenant').select('*');
  if (tenantErr) throw tenantErr;

  const updates: any[] = [];

  for (const tenant of tenants) {
    const { data: programs, error: progErr } = await supabase
      .from('Program')
      .select('*')
      .eq('tenantId', tenant.id)
      .order('createdAt', { ascending: true });
    
    if (progErr) throw progErr;
    if (!programs || programs.length <= 1) continue;

    // Skip the first "original" program
    const nonOriginalPrograms = programs.slice(1);

    for (const program of nonOriginalPrograms) {
      // Best-effort match for preset (business_card preset has no URLs)
      const preset = 
        PROGRAM_PRESETS.find(p => p.kind === program.kind && p.archetype === program.archetype) || 
        PROGRAM_PRESETS.find(p => p.kind === program.kind);
      
      if (!preset || (!preset.logoUrl && !preset.heroUrl)) continue;

      const { data: templates, error: tmplErr } = await supabase
        .from('PassTemplate')
        .select('*')
        .eq('programId', program.id);
      
      if (tmplErr) throw tmplErr;

      for (const template of templates || []) {
        let needsUpdate = false;
        let newLogoUrl = template.logoUrl;
        let newHeroUrl = template.heroImageUrl;

        if (template.logoUrl === tenant.logoUrl && preset.logoUrl) {
          needsUpdate = true;
          newLogoUrl = preset.logoUrl;
        }
        
        if (template.heroImageUrl === tenant.heroUrl && preset.heroUrl) {
          needsUpdate = true;
          newHeroUrl = preset.heroUrl;
        }

        if (needsUpdate) {
          updates.push({
            templateId: template.id,
            programName: program.name,
            tenantName: tenant.name,
            oldLogo: template.logoUrl,
            newLogo: newLogoUrl,
            oldHero: template.heroImageUrl,
            newHero: newHeroUrl,
          });
        }
      }
    }
  }

  console.log(`Found ${updates.length} templates to update:`);
  console.table(updates);

  if (process.argv.includes('--apply')) {
    console.log('Applying updates...');
    for (const u of updates) {
      const { error } = await supabase
        .from('PassTemplate')
        .update({ logoUrl: u.newLogo, heroImageUrl: u.newHero })
        .eq('id', u.templateId);
      if (error) {
        console.error(`Failed to update ${u.templateId}:`, error.message);
      } else {
        console.log(`Updated ${u.templateId}`);
      }
    }
    console.log('Done.');
  } else {
    console.log('\nRun with --apply to execute the updates.');
  }
}

run().catch(console.error);
