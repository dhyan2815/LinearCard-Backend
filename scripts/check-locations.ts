import { createClient } from '@supabase/supabase-js';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkLocations() {
  const { data: templates } = await supabase
    .from('PassTemplate')
    .select('id, programId, storeLocations')
    .eq('classSuffix', 'bistro_cafe_gift_card_member')
    .single();

  console.log('Template:', templates);

  if (templates?.programId) {
    const { data: program } = await supabase
      .from('Program')
      .select('id, storeLocations')
      .eq('id', templates.programId)
      .single();
    
    console.log('Program:', program);
  }
}

checkLocations();
