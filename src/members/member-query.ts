import type { SupabaseClient } from '@supabase/supabase-js';

export interface MemberQueryOptions {
  tenantId: string;
  /** Narrows to members holding a live pass in this program. */
  programId?: string;
  limit: number;
  offset: number;
  q?: string;
  dir?: string;
}

/**
 * One builder for both the tenant-wide member list and the program-scoped one.
 * Two copies of this drifted the moment either grew a filter.
 *
 * Program membership is derived, not stored: a member belongs to a program
 * when they hold a Pass in it. The inner-join hint on the embedded Pass
 * select is what turns the embed into a filter instead of a decoration.
 */
export function buildMemberQuery(
  client: SupabaseClient | any,
  opts: MemberQueryOptions,
) {
  const passSelect = opts.programId
    ? 'passes:Pass!inner(id, fullPassId, tier, balance, programId, deletedAt)'
    : 'passes:Pass(id, fullPassId, tier, balance, programId, deletedAt)';

  let query = client
    .from('Member')
    .select(
      `id, name, phone, tenantId, createdAt, isTestAccount, Tenant(name), ${passSelect}`,
      { count: 'exact' },
    )
    .eq('tenantId', opts.tenantId);

  if (opts.programId) {
    query = query
      .eq('passes.programId', opts.programId)
      .is('passes.deletedAt', null);
  }

  if (opts.q) {
    query = query.or(`name.ilike.%${opts.q}%,phone.ilike.%${opts.q}%`);
  }

  return (
    query
      // Only a Member column can order a paged query; balance lives on the
      // child Pass rows, so sorting by it would only ever sort the page.
      .order('name', { ascending: opts.dir !== 'desc' })
      .order('createdAt', { ascending: false })
      .range(opts.offset, opts.offset + opts.limit - 1)
  );
}
