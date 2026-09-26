import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SHARED_CONTROLLERS, SHARED_PROVIDERS } from '../app.module';
import { DEPLOYMENT_MODE } from './deployment-mode';
import { LocalAuthService } from './local-auth.service';
import { StandaloneAuthController } from './standalone-auth.controller';
import { StandaloneController } from './standalone.controller';
import { LocalStatusController } from './local-status.controller';
import { LicenseGateService } from './platform/license-gate.service';
import { PlatformDeviceService } from './platform/platform-device.service';
import { PlatformDeviceController } from './platform/platform-device.controller';
import { PlatformSyncRuntime } from './platform/platform-sync.runtime';
import { HttpPlatformDeviceClient } from './platform/platform-device.client';
import { PLATFORM_DEVICE_API } from './platform/platform-device.contract';

/**
 * Standalone PC edition. Not registered here on purpose: Platform SSO (CrmAuthController), signed
 * Platform events/tenant lifecycle (PlatformEventsController), the Platform control API
 * (InstallationsController) and the operator console (/admin/*). Tenant, users and the source API credential are
 * local. Platform is only the licensing control plane, reached by the PC over HTTPS (Platform Device Agent).
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [StandaloneAuthController, StandaloneController, LocalStatusController, PlatformDeviceController, ...SHARED_CONTROLLERS],
  providers: [
    ...SHARED_PROVIDERS, LocalAuthService, { provide: DEPLOYMENT_MODE, useValue: 'standalone' },
    LicenseGateService, PlatformDeviceService, PlatformSyncRuntime, { provide: PLATFORM_DEVICE_API, useClass: HttpPlatformDeviceClient },
  ],
})
export class StandaloneAppModule {}
