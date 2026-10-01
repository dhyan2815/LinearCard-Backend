import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';
import { isSelectableCategory } from '../programs/presets';

@Controller('settings')
@UseGuards(TenantGuard)
export class SettingsController {
  constructor(private readonly supabaseService: SupabaseService) {}

  @Get()
  async getSettings(@Req() req: TenantRequest) {
    const tenantId = req.tenantId;

    const { data: tenant, error } = await this.supabaseService.client
      .from('Tenant')
      .select(
        'id, name, classSuffix, brandHexColor, apiKey, webhookUrl, businessCategory',
      )
      .eq('id', tenantId)
      .single();
    if (error || !tenant)
      throw new HttpException('Tenant not found', HttpStatus.NOT_FOUND);
    return { success: true, tenant };
  }

  @Patch()
  async updateSettings(@Req() req: TenantRequest, @Body() body: any) {
    const tenantId = req.tenantId;

    const { webhookUrl, businessCategory } = body || {};
    const patch: Record<string, any> = {};
    if (webhookUrl !== undefined) {
      if (webhookUrl && !/^https?:\/\/.+/.test(webhookUrl)) {
        throw new HttpException(
          'webhookUrl must be a valid http/https URL',
          HttpStatus.BAD_REQUEST,
        );
      }
      patch.webhookUrl = webhookUrl || null;
    }
    // Only gates programs created from now on; existing ones are untouched.
    if (businessCategory !== undefined) {
      if (!isSelectableCategory(businessCategory))
        throw new HttpException(
          'businessCategory is not a valid business category',
          HttpStatus.BAD_REQUEST,
        );
      patch.businessCategory = businessCategory;
    }
    if (!Object.keys(patch).length) {
      throw new HttpException(
        'No updateable fields provided',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { error } = await this.supabaseService.client
      .from('Tenant')
      .update(patch)
      .eq('id', tenantId);
    if (error)
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    return { success: true };
  }
}

@Controller('admin')
@UseGuards(TenantGuard)
export class DeveloperSettingsController {
  constructor(private readonly supabaseService: SupabaseService) {}

  @Get('developer-settings')
  async getDevSettings(@Req() req: TenantRequest) {
    const tenantId = req.tenantId;

    const { data: tenant } = await this.supabaseService.client
      .from('Tenant')
      .select('*')
      .eq('id', tenantId)
      .limit(1)
      .single();
    if (!tenant)
      throw new HttpException('Tenant not found', HttpStatus.NOT_FOUND);

    return { success: true, apiKey: tenant.apiKey };
  }

  // ponytail: legacy plaintext-minting path retired in favor of hashed keys.
  // Retained as a 410 so old clients get a clear signal instead of a 404.
  @Post('developer-settings')
  generateApiKey() {
    throw new HttpException(
      'This endpoint no longer issues API keys. Use POST /developers/api-keys instead.',
      HttpStatus.GONE,
    );
  }
}
