import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT || 4100), process.env.HOST || '127.0.0.1');
}

void bootstrap();
