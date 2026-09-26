import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { StandaloneAppModule } from './standalone/standalone-app.module';
import { deploymentModeFromEnv } from './standalone/deployment-mode';

/**
 * PROCESS_ROLE: `all` (default, API + in-process worker as before), `api` (HTTP only) or `worker`
 * (queue worker without an HTTP listener). The standalone PC edition runs api and worker as two services.
 */
async function bootstrap(): Promise<void> {
  const role = process.env.PROCESS_ROLE || 'all';
  if (!['all', 'api', 'worker'].includes(role)) throw new Error(`Invalid PROCESS_ROLE ${role}`);
  const root = deploymentModeFromEnv() === 'standalone' ? StandaloneAppModule : AppModule;
  if (role === 'api') process.env.WORKER_ENABLED = 'false';
  if (role === 'worker') {
    process.env.WORKER_ENABLED = 'true';
    const ctx = await NestFactory.createApplicationContext(root);
    ctx.enableShutdownHooks();
    // Liveness for the service wrapper / tray: a small file rewritten every 10 s (no data, no secrets).
    // This interval is not unref'd on purpose: it also keeps the worker process alive (the worker loop timer is).
    const heartbeat = process.env.WORKER_HEARTBEAT_FILE;
    setInterval(() => {
      if (!heartbeat) return;
      try { writeFileSync(heartbeat, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch { /* best effort */ }
    }, 10_000);
    return;
  }
  const app = await NestFactory.create<NestExpressApplication>(root, { rawBody: true });
  const origin = process.env.CRM_PUBLIC_ORIGIN || '';
  if (root === StandaloneAppModule && origin.startsWith('http://127.0.0.1:')) {
    // PC edition: "localhost" and "127.0.0.1" are different browser origins; keep one so the Origin/CSRF check holds.
    app.use((req: { method: string; headers: { host?: string }; originalUrl: string }, res: { redirect: (code: number, url: string) => void }, next: () => void) => {
      if (req.method === 'GET' && req.headers.host?.toLowerCase().startsWith('localhost:')) return res.redirect(307, `${origin}${req.originalUrl}`);
      next();
    });
  }
  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT || 4100), process.env.HOST || '127.0.0.1');
}

void bootstrap();
