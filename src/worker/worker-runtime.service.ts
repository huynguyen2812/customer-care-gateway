import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CareWorkerService } from './care-worker.service';
import { WebhookOutboxService } from '../webhooks/webhook-outbox.service';
import { MaintenanceService } from './maintenance.service';

@Injectable()
export class WorkerRuntimeService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private ticks = 0;
  constructor(private readonly worker: CareWorkerService, private readonly webhooks: WebhookOutboxService, private readonly maintenance: MaintenanceService) {}
  onModuleInit(): void {
    if (process.env.WORKER_ENABLED !== 'true') return;
    this.timer = setInterval(() => void this.tick(), 1000); this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  private async tick(): Promise<void> {
    await this.worker.processNext(); await this.webhooks.deliverNext();
    this.ticks++; if (this.ticks % 3600 === 0) await this.maintenance.run();
  }
}
