import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
    // Prisma stores DateTime as UTC in `timestamp without time zone`; raw SQL such as the worker claim compares it
    // with NOW(). A server TimeZone other than UTC (the Windows default of a bundled PostgreSQL) silently shifts every
    // due-time comparison, so refuse to start instead of scheduling wrongly.
    const rows = await this.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    const tz = rows[0]?.tz || '';
    if (!['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Etc/Universal', 'Universal', 'Zulu'].includes(tz)) {
      throw new Error(`DATABASE_TIMEZONE_NOT_UTC: PostgreSQL TimeZone is "${tz}", set timezone = 'UTC'`);
    }
  }
  async onModuleDestroy(): Promise<void> { await this.$disconnect(); }
}
