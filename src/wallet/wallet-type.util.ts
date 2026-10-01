import { SupabaseClient } from '@supabase/supabase-js';
import type { WalletType } from '../types';

/**
 * Looks up a Program's walletType, scoped to the tenant that owns it.
 * Replaces three duplicated, unscoped copies of this lookup.
 */
export async function walletTypeForProgram(
  client: SupabaseClient,
  tenantId: string,
  programId?: string | null,
): Promise<WalletType> {
  if (!programId) return 'generic';
  const { data } = await client
    .from('Program')
    .select('walletType')
    .eq('id', programId)
    .eq('tenantId', tenantId)
    .maybeSingle();
  return (data?.walletType as WalletType) || 'generic';
}
