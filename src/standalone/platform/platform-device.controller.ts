import { BadRequestException, Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Crm, CrmAuthGuard, RequirePermission } from '../../crm/crm-auth.guard';
import { CrmContext } from '../../crm/crm-session.service';
import { buildInfo, PlatformDeviceService } from './platform-device.service';

/**
 * "Kết nối Platform". The browser sends only the activation code — never a tenantId, branchId or Platform URL:
 * tenant/device/scope come from the verified signed configuration; the URL comes from the release configuration.
 */
@Controller('crm/local')
@UseGuards(CrmAuthGuard)
export class PlatformDeviceController {
  constructor(private readonly device: PlatformDeviceService) {}

  @Get('platform') @RequirePermission('crm.settings.read')
  status() { return this.device.status(); }

  @Post('platform/activate') @HttpCode(200) @RequirePermission('crm.users.manage')
  activate(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) { return this.device.activate(body?.activationCode, crm.platformUserId, crm.platformTenantId); }

  @Post('platform/sync') @HttpCode(200) @RequirePermission('crm.settings.manage')
  async sync() { await this.device.sync('MANUAL'); return this.device.status(); }

  @Post('platform/unpair') @HttpCode(200) @RequirePermission('crm.users.manage')
  unpair(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) {
    if (body?.confirm !== 'NGAT GHEP NOI') throw new BadRequestException({ code: 'CONFIRM_REQUIRED', message: 'Gõ đúng "NGAT GHEP NOI" để xác nhận.' });
    return this.device.unpair(crm.platformUserId, crm.platformTenantId);
  }

  /** Build identity (traceable installer): version + commits + dirty flag from BUILD-INFO.json. */
  @Get('version') @RequirePermission('crm.dashboard.read')
  version() { return buildInfo(); }
}
