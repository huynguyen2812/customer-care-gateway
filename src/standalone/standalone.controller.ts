import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { Crm, CrmAuthGuard, RequirePermission, RequiresSendingEntitlement } from '../crm/crm-auth.guard';
import { CrmContext } from '../crm/crm-session.service';
import { LocalAuthService } from './local-auth.service';
import { LocalCredentialsService } from './local-credentials.service';
import { SourceConnectorService } from './source-connector.service';

/**
 * Standalone-only management API (tenant from the CRM session, never from the request):
 * staff accounts, the self-issued API credential, the source connector and the local emergency stop.
 */
@Controller('crm/local')
@UseGuards(CrmAuthGuard)
export class StandaloneController {
  constructor(private readonly prisma: PrismaService, private readonly local: LocalAuthService, private readonly credentials: LocalCredentialsService, private readonly connector: SourceConnectorService) {}

  // ---------- staff ----------
  @Get('users') @RequirePermission('crm.users.manage')
  users(@Crm() crm: CrmContext) { return this.local.listUsers(crm.platformTenantId); }

  @Post('users') @HttpCode(200) @RequirePermission('crm.users.manage')
  createUser(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) { return this.local.createUser(crm.platformTenantId, crm.platformUserId, body || {}); }

  @Patch('users/:id') @RequirePermission('crm.users.manage')
  updateUser(@Crm() crm: CrmContext, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.local.updateUser(crm.platformTenantId, crm.platformUserId, id, body || {}); }

  // ---------- self-issued API credential ----------
  @Get('api-credentials') @RequirePermission('crm.sources.read')
  async apiCredentials(@Crm() crm: CrmContext) {
    const inst = await this.connector.installationFor(crm.platformTenantId);
    return { installationId: inst.id, credentials: await this.credentials.list(inst.id) };
  }

  @Post('api-credentials/rotate') @HttpCode(200) @RequirePermission('crm.sources.manage')
  async rotate(@Crm() crm: CrmContext) {
    const inst = await this.connector.installationFor(crm.platformTenantId);
    return this.credentials.rotate(inst.id, crm.platformTenantId, crm.platformUserId);
  }

  @Post('api-credentials/:clientId/revoke') @HttpCode(200) @RequirePermission('crm.sources.manage')
  async revoke(@Crm() crm: CrmContext, @Param('clientId') clientId: string) {
    const inst = await this.connector.installationFor(crm.platformTenantId);
    return this.credentials.revoke(inst.id, crm.platformTenantId, String(clientId).slice(0, 80), crm.platformUserId);
  }

  // ---------- source connector ----------
  @Get('source-connector') @RequirePermission('crm.sources.read')
  sourceConnector(@Crm() crm: CrmContext) { return this.connector.get(crm); }

  @Put('source-connector') @RequirePermission('crm.sources.manage')
  configure(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) { return this.connector.configure(crm, body || {}); }

  @Post('source-connector/appointments/preview') @HttpCode(200) @RequirePermission('crm.sources.read')
  preview(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) { return this.connector.syncAppointments(crm, { ...(body || {}), commit: false }); }

  @Post('source-connector/appointments/sync') @HttpCode(200) @RequirePermission('crm.sources.manage') @RequiresSendingEntitlement()
  sync(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) { return this.connector.syncAppointments(crm, { ...(body || {}), commit: true }); }

  @Get('source-connector/receivables') @RequirePermission('crm.customers.read')
  receivables(@Crm() crm: CrmContext) { return this.connector.receivables(crm); }

  @Post('source-connector/receivables/:id/queue') @HttpCode(200) @RequirePermission('crm.jobs.create') @RequiresSendingEntitlement()
  queueReceivable(@Crm() crm: CrmContext, @Param('id') id: string) { return this.connector.queueReceivable(crm, id); }

  // ---------- local emergency stop (the whole PC has one business) ----------
  @Get('emergency-stop') @RequirePermission('crm.settings.read')
  async emergencyStop() {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'kill_switch' } });
    const v = (row?.value || {}) as { enabled?: boolean; reason?: string | null; changedAt?: string };
    return { enabled: v.enabled === true, reason: v.reason ?? null, changedAt: v.changedAt ?? null };
  }

  @Put('emergency-stop') @RequirePermission('crm.settings.manage')
  async setEmergencyStop(@Crm() crm: CrmContext, @Body() body: Record<string, unknown>) {
    const enabled = body?.enabled === true;
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 300) : null;
    const value = { enabled, reason, changedAt: new Date().toISOString() };
    await this.prisma.systemSetting.upsert({ where: { key: 'kill_switch' }, create: { key: 'kill_switch', value, updatedBy: `crm:${crm.platformUserId}` }, update: { value, updatedBy: `crm:${crm.platformUserId}` } });
    await this.prisma.auditLog.create({ data: { tenantId: crm.platformTenantId, actorType: 'CRM_USER', actorId: crm.platformUserId, action: enabled ? 'SYSTEM_KILL_SWITCH_ENABLED' : 'SYSTEM_KILL_SWITCH_DISABLED', result: 'SUCCESS', reason } });
    return { enabled };
  }
}
