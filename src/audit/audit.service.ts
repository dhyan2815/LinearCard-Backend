import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export interface AuditRecordInput {
  tenantId: string;
  memberId: string;
  passId?: string | null;
  /** Phase 8 — a real column, so per-program feeds are one indexed filter. */
  programId?: string | null;
  actor: string;
  action: string;
  details?: Record<string, any> | null;
}

/**
 * Single writer for the `AuditLog` table. The table has no `passId` column,
 * so passId (when given) is folded into `details` — keeps all call sites
 * consistent instead of each inlining its own shape.
 */
@Injectable()
export class AuditService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async record({
    tenantId,
    memberId,
    passId,
    programId,
    actor,
    action,
    details,
  }: AuditRecordInput): Promise<void> {
    await this.supabaseService.client.from('AuditLog').insert({
      tenantId,
      memberId,
      programId: programId ?? null,
      actor,
      action,
      details: passId ? { passId, ...details } : details || {},
    });
  }
}
