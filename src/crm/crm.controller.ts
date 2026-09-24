import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Crm, CrmAuthGuard, RequirePermission, RequiresSendingEntitlement } from './crm-auth.guard';
import { CrmContext } from './crm-session.service';
import { CrmDataService } from './crm-data.service';
import { ZaloAccountsService } from './zalo-accounts.service';
import { B2bSourceService } from '../b2b/b2b-source.service';

/** Customer-facing, tenant-scoped API. Tenant comes only from the server-side CRM session. */
@Controller('crm')
@UseGuards(CrmAuthGuard)
export class CrmController {
  constructor(private readonly data: CrmDataService, private readonly zalo: ZaloAccountsService, private readonly b2b: B2bSourceService) {}

  @Get('overview') @RequirePermission('crm.dashboard.read')
  overview(@Crm() crm: CrmContext, @Query('period') period?: string) { return this.data.overview(crm, String(period || '7d')); }

  @Get('installations') @RequirePermission('crm.sources.read')
  installations(@Crm() crm: CrmContext) { return this.data.installations(crm); }

  @Get('installations/:id') @RequirePermission('crm.sources.read')
  installation(@Crm() crm: CrmContext, @Param('id') id: string) { return this.data.installation(crm, id); }

  @Get('b2b-receivables') @RequirePermission('crm.customers.read')
  b2bReceivables(@Crm() crm: CrmContext) { return this.b2b.list(crm); }

  @Post('b2b-receivables/:externalReferenceId/queue') @HttpCode(200) @RequirePermission('crm.jobs.create') @RequiresSendingEntitlement()
  queueB2bReminder(@Crm() crm: CrmContext, @Param('externalReferenceId') externalReferenceId: string) { return this.b2b.queue(crm, externalReferenceId); }

  @Post('installations/:id/petclinic') @HttpCode(200) @RequirePermission('crm.sources.manage') @RequiresSendingEntitlement()
  configurePetclinic(@Crm() crm: CrmContext, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.data.configurePetclinic(crm, id, body || {}); }

  @Post('installations/:id/petclinic/preview') @HttpCode(200) @RequirePermission('crm.sources.manage') @RequiresSendingEntitlement()
  previewPetclinic(@Crm() crm: CrmContext, @Param('id') id: string) { return this.data.previewPetclinic(crm, id); }

  @Get('customers') @RequirePermission('crm.customers.read')
  customers(@Crm() crm: CrmContext, @Query() q: Record<string, unknown>) { return this.data.customers(crm, q); }

  @Get('customers/:id') @RequirePermission('crm.customers.read')
  customer(@Crm() crm: CrmContext, @Param('id') id: string) { return this.data.customer(crm, id); }

  @Get('templates') @RequirePermission('crm.templates.read')
  templates(@Crm() crm: CrmContext) { return this.data.templates(crm); }

  @Post('templates') @HttpCode(200) @RequirePermission('crm.templates.manage') @RequiresSendingEntitlement()
  upsertTemplate(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) { return this.data.upsertTemplate(crm, body || {}); }

  @Patch('templates/:id') @RequirePermission('crm.templates.manage')
  setTemplateActive(@Crm() crm: CrmContext, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.data.setTemplateActive(crm, id, body?.active); }

  @Get('jobs') @RequirePermission('crm.jobs.read')
  jobs(@Crm() crm: CrmContext, @Query() q: Record<string, unknown>) { return this.data.jobs(crm, q); }

  @Get('jobs/:id') @RequirePermission('crm.jobs.read')
  job(@Crm() crm: CrmContext, @Param('id') id: string) { return this.data.job(crm, id); }

  @Post('jobs/:id/cancel') @HttpCode(200) @RequirePermission('crm.jobs.cancel')
  async cancel(@Crm() crm: CrmContext, @Param('id') id: string) {
    const out = await this.data.cancelJobs(crm, [id]);
    const r = out.results[0];
    if (r.reason === 'NOT_FOUND') return this.data.job(crm, id); // throws the same 404 as any unknown id
    return { id, cancelled: r.cancelled };
  }

  @Post('jobs/cancel') @HttpCode(200) @RequirePermission('crm.jobs.cancel')
  cancelMany(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) { return this.data.cancelJobs(crm, body?.ids); }

  @Get('opt-outs') @RequirePermission('crm.optouts.read')
  optOuts(@Crm() crm: CrmContext, @Query() q: Record<string, unknown>) { return this.data.optOuts(crm, q); }

  @Delete('opt-outs/:id') @RequirePermission('crm.optouts.manage') @RequiresSendingEntitlement()
  removeOptOut(@Crm() crm: CrmContext, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.data.removeOptOut(crm, id, body?.reason); }

  @Get('audit') @RequirePermission('crm.audit.read')
  audit(@Crm() crm: CrmContext, @Query() q: Record<string, unknown>) { return this.data.audit(crm, q); }

  @Get('settings') @RequirePermission('crm.settings.read')
  settings(@Crm() crm: CrmContext) { return this.data.settings(crm); }

  @Patch('settings') @RequirePermission('crm.settings.manage')
  updateSettings(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) { return this.data.updateSettings(crm, body || {}); }

  // ---------- Zalo accounts (tenant-owned, many per tenant) ----------
  @Get('zalo-accounts') @RequirePermission('crm.zalo.read')
  zaloAccounts(@Crm() crm: CrmContext) { return this.zalo.list(crm); }

  @Get('zalo-accounts/:id') @RequirePermission('crm.zalo.read')
  zaloAccount(@Crm() crm: CrmContext, @Param('id') id: string) { return this.zalo.get(crm, id); }

  @Post('zalo-accounts') @HttpCode(200) @RequirePermission('crm.zalo.manage') @RequiresSendingEntitlement()
  createZaloAccount(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) { return this.zalo.create(crm, body || {}); }

  @Patch('zalo-accounts/:id') @RequirePermission('crm.zalo.manage')
  updateZaloAccount(@Crm() crm: CrmContext, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.zalo.update(crm, id, body || {}); }

  @Post('zalo-accounts/:id/sender/register') @HttpCode(200) @RequirePermission('crm.zalo.manage') @RequiresSendingEntitlement()
  registerZaloSender(@Crm() crm: CrmContext, @Param('id') id: string) { return this.zalo.registerWithSender(crm, id); }

  @Post('zalo-accounts/:id/pause') @HttpCode(200) @RequirePermission('crm.zalo.manage')
  pauseZaloAccount(@Crm() crm: CrmContext, @Param('id') id: string) { return this.zalo.setPaused(crm, id, true); }

  @Post('zalo-accounts/:id/resume') @HttpCode(200) @RequirePermission('crm.zalo.manage') @RequiresSendingEntitlement()
  resumeZaloAccount(@Crm() crm: CrmContext, @Param('id') id: string) { return this.zalo.setPaused(crm, id, false); }

  @Post('zalo-accounts/:id/disconnect') @HttpCode(200) @RequirePermission('crm.zalo.manage')
  disconnectZaloAccount(@Crm() crm: CrmContext, @Param('id') id: string) { return this.zalo.disconnect(crm, id); }

  @Post('zalo-accounts/:id/login/start') @HttpCode(200) @RequirePermission('crm.zalo.manage') @RequiresSendingEntitlement()
  zaloLoginStart(@Crm() crm: CrmContext, @Param('id') id: string) { return this.zalo.loginStart(crm, id); }

  @Get('zalo-accounts/:id/login/status') @RequirePermission('crm.zalo.manage')
  zaloLoginStatus(@Crm() crm: CrmContext, @Param('id') id: string, @Query('loginId') loginId: string) { return this.zalo.loginStatus(crm, id, loginId); }

  @Get('zalo-routing-rules') @RequirePermission('crm.zalo.read')
  zaloRules(@Crm() crm: CrmContext) { return this.zalo.rules(crm); }

  @Put('zalo-routing-rules') @RequirePermission('crm.zalo.manage')
  replaceZaloRules(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) { return this.zalo.replaceRules(crm, body || {}); }
}
