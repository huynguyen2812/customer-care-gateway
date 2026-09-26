import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './common/prisma.service';
import { CryptoService } from './common/crypto.service';
import { HmacAuthService } from './auth/hmac-auth.service';
import { InstallationGuard } from './auth/installation.guard';
import { PlatformControlGuard } from './auth/platform-control.guard';
import { InstallationsController } from './installations/installations.controller';
import { InstallationsService } from './installations/installations.service';
import { CareJobsController } from './care-jobs/care-jobs.controller';
import { CareJobsService } from './care-jobs/care-jobs.service';
import { MockAdapter } from './channel/mock.adapter';
import { SourceVerifierService } from './worker/source-verifier.service';
import { WebhookOutboxService } from './webhooks/webhook-outbox.service';
import { CareWorkerService } from './worker/care-worker.service';
import { WorkerRuntimeService } from './worker/worker-runtime.service';
import { MaintenanceService } from './worker/maintenance.service';
import { PersonalZaloAdapter } from './channel/personal-zalo.adapter';
import { ChannelRouterService } from './channel/channel-router.service';
import { TemplateService } from './templates/template.service';
import { PetclinicClientService } from './petclinic/petclinic-client.service';
import { PetclinicSyncService } from './petclinic/petclinic-sync.service';
import { HealthController } from './health.controller';
import { AdminAuthController } from './admin/admin-auth.controller';
import { AdminAuthGuard } from './admin/admin-auth.guard';
import { AdminAuthService } from './admin/admin-auth.service';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { CrmAuthController } from './crm/crm-auth.controller';
import { CrmAuthGuard } from './crm/crm-auth.guard';
import { CrmController } from './crm/crm.controller';
import { CrmDataService } from './crm/crm-data.service';
import { CrmSessionService } from './crm/crm-session.service';
import { PlatformClientService } from './crm/platform-client.service';
import { PlatformEventsController } from './crm/platform-events.controller';
import { SenderHealthController } from './channel/sender-health.controller';
import { TenantAccessService } from './crm/tenant-access.service';
import { TenantLifecycleService } from './crm/tenant-lifecycle.service';
import { AccountSelectorService } from './delivery/account-selector.service';
import { QuotaService } from './delivery/quota.service';
import { ZaloAccountsService } from './crm/zalo-accounts.service';
import { B2bSourceService } from './b2b/b2b-source.service';
import { LocalCredentialsService } from './standalone/local-credentials.service';
import { SourceConnectorClient } from './standalone/source-connector.client';
import { SourceConnectorService } from './standalone/source-connector.service';
import { DEPLOYMENT_MODE } from './standalone/deployment-mode';

/** Controllers shared by both editions (tenant-scoped CRM API, signed care-job API, sender callbacks). */
export const SHARED_CONTROLLERS = [CareJobsController, HealthController, CrmController, SenderHealthController];

/** Providers shared by both editions. Platform-only services stay registered but are never reached in standalone. */
export const SHARED_PROVIDERS = [
  PrismaService,
  CryptoService,
  HmacAuthService,
  InstallationGuard,
  PlatformControlGuard,
  InstallationsService,
  CareJobsService,
  B2bSourceService,
  MockAdapter,
  PersonalZaloAdapter,
  ChannelRouterService,
  TemplateService,
  PetclinicClientService,
  PetclinicSyncService,
  SourceVerifierService,
  WebhookOutboxService,
  CareWorkerService,
  WorkerRuntimeService,
  MaintenanceService,
  AdminAuthGuard,
  AdminAuthService,
  AdminService,
  PlatformClientService,
  CrmSessionService,
  CrmAuthGuard,
  CrmDataService,
  TenantAccessService,
  TenantLifecycleService,
  AccountSelectorService,
  QuotaService,
  ZaloAccountsService,
  LocalCredentialsService,
  SourceConnectorClient,
  SourceConnectorService,
];

/** VPS edition driven by Platform Admin (SSO, signed Platform events, operator console). */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [InstallationsController, AdminAuthController, AdminController, CrmAuthController, PlatformEventsController, ...SHARED_CONTROLLERS],
  providers: [...SHARED_PROVIDERS, { provide: DEPLOYMENT_MODE, useValue: 'platform' }],
})
export class AppModule {}
