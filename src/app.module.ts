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

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [InstallationsController, CareJobsController, HealthController],
  providers: [
    PrismaService,
    CryptoService,
    HmacAuthService,
    InstallationGuard,
    PlatformControlGuard,
    InstallationsService,
    CareJobsService,
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
  ],
})
export class AppModule {}
