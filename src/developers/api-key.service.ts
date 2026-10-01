import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

const PREFIX_LEN = 12;

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Issues/revokes ApiKey rows. Keys are `lc_live_<32 hex chars>`; only the
 * SHA-256 hash is stored — the plaintext is returned once, on issue, and
 * never retrievable again. `prefix` (first 12 chars) is kept for display.
 */
@Injectable()
export class ApiKeyService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async issue(tenantId: string, name?: string) {
    const key = `lc_live_${crypto.randomBytes(24).toString('hex')}`;
    const prefix = key.slice(0, PREFIX_LEN);
    const hash = hashApiKey(key);

    const { data, error } = await this.supabaseService.client
      .from('ApiKey')
      .insert({ tenantId, name: name || null, prefix, hash })
      .select('id, name, prefix, createdAt')
      .single();
    if (error) throw error;

    // Full plaintext key is only ever available in this response.
    return { ...data, key };
  }

  async list(tenantId: string) {
    const { data, error } = await this.supabaseService.client
      .from('ApiKey')
      .select('id, name, prefix, lastUsedAt, createdAt, revokedAt')
      .eq('tenantId', tenantId)
      .order('createdAt', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async revoke(tenantId: string, id: string) {
    const { error } = await this.supabaseService.client
      .from('ApiKey')
      .update({ revokedAt: new Date().toISOString() })
      .eq('id', id)
      .eq('tenantId', tenantId);
    if (error) throw error;
  }
}
