import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';
import { buildMemberQuery } from '../members/member-query';

/**
 * Phase 8 — the program's own Members and Member Events tabs. Separate from
 * ProgramsController, which is already long enough; same route prefix.
 */
@Controller('programs')
@UseGuards(TenantGuard)
export class ProgramMembersController {
  constructor(private readonly supabaseService: SupabaseService) {}

  /** Loads a program the calling tenant owns, or 404s. */
  private async load(id: string, tenantId: string) {
    const { data } = await this.supabaseService.client
      .from('Program')
      .select('id, name')
      .eq('id', id)
      .eq('tenantId', tenantId)
      .maybeSingle();
    if (!data)
      throw new HttpException(
        { success: false, error: 'Program not found' },
        HttpStatus.NOT_FOUND,
      );
    return data;
  }

  @Get(':id/members')
  async members(
    @Param('id') id: string,
    @Req() req: TenantRequest,
    @Query('limit') limitQuery?: string,
    @Query('offset') offsetQuery?: string,
    @Query('q') q?: string,
    @Query('dir') dir?: string,
  ) {
    await this.load(id, req.tenantId!);
    const limit = Math.min(
      Number(limitQuery) > 0 ? Number(limitQuery) : 50,
      200,
    );
    const offset = Number(offsetQuery) >= 0 ? Number(offsetQuery) : 0;

    const { data, error, count } = await buildMemberQuery(
      this.supabaseService.client,
      { tenantId: req.tenantId!, programId: id, limit, offset, q, dir },
    );
    if (error)
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    return { success: true, members: data || [], total: count ?? 0 };
  }

  @Get(':id/events')
  async events(
    @Param('id') id: string,
    @Req() req: TenantRequest,
    @Query('limit') limitQuery?: string,
    @Query('offset') offsetQuery?: string,
  ) {
    await this.load(id, req.tenantId!);
    const limit = Math.min(
      Number(limitQuery) > 0 ? Number(limitQuery) : 50,
      200,
    );
    const offset = Number(offsetQuery) >= 0 ? Number(offsetQuery) : 0;

    const { data, error, count } = await this.supabaseService.client
      .from('AuditLog')
      .select('id, memberId, action, actor, createdAt, Member(name, phone)', {
        count: 'exact',
      })
      .eq('tenantId', req.tenantId)
      .eq('programId', id)
      .order('createdAt', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error)
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    return {
      success: true,
      total: count ?? 0,
      events: (data || []).map((row: any) => ({
        id: row.id,
        memberId: row.memberId,
        memberName: row.Member?.name ?? null,
        phone: row.Member?.phone ?? null,
        action: row.action,
        actor: row.actor,
        occurredAt: row.createdAt,
      })),
    };
  }
}
