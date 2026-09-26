import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PlatformDeviceService } from './platform-device.service';
import { PLATFORM_SYNC_MAX_INTERVAL_MS } from './platform-device.contract';

/**
 * Sync period: PLATFORM_SYNC_INTERVAL_SECONDS (default 60, clamped to 15..120). The shared contract requires a sync at
 * least every 2 minutes: with offlineGraceHours = 0 the signed lease is 5 minutes and Platform renews it from
 * 3 min 20 s. Platform alone decides when to issue a new revision; the PC just syncs on schedule.
 */
export function syncIntervalMs(raw = process.env.PLATFORM_SYNC_INTERVAL_SECONDS): number {
  const seconds = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.max(seconds * 1000, 15_000), PLATFORM_SYNC_MAX_INTERVAL_MS) : 60_000;
}

/** Worker process only: first sync 10 s after start, then every syncIntervalMs(). */
@Injectable()
export class PlatformSyncRuntime implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  constructor(private readonly device: PlatformDeviceService) {}

  onModuleInit() {
    if (process.env.WORKER_ENABLED !== 'true') return;
    const run = async () => {
      if (this.running) return; this.running = true;
      try { await this.device.sync('SCHEDULE'); } catch { /* recorded in registration.lastSyncError */ } finally { this.running = false; }
    };
    const first = setTimeout(() => void run(), 10_000); first.unref();
    const every = setInterval(() => void run(), syncIntervalMs()); every.unref();
    this.timers.push(first, every);
  }

  onModuleDestroy() { for (const t of this.timers) clearTimeout(t); }
}
