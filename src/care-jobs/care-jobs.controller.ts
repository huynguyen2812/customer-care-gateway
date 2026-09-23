import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { InstallationGuard } from '../auth/installation.guard';
import { CareJobsService } from './care-jobs.service';

@Controller()
@UseGuards(InstallationGuard)
export class CareJobsController {
  constructor(private readonly service: CareJobsService) {}
  private ctx(req: Request) { if (!req.installationContext) throw new Error('Missing installation context'); return req.installationContext; }
  @Post('care-jobs') create(@Req() req: Request, @Body() body: Record<string, any>) { return this.service.create(this.ctx(req), body); }
  @Get('care-jobs/:id') get(@Req() req: Request, @Param('id') id: string) { return this.service.get(this.ctx(req), id); }
  @Post('care-jobs/:id/cancel') cancel(@Req() req: Request, @Param('id') id: string) { return this.service.cancel(this.ctx(req), id); }
  @Post('opt-outs') optOut(@Req() req: Request, @Body() body: Record<string, unknown>) { return this.service.optOut(this.ctx(req), body.phone, String(body.source || 'SOURCE_PRODUCT')); }
  @Get('installation/status') ownStatus(@Req() req: Request) {
    const ctx = this.ctx(req); const i = ctx.installation;
    return { installationId: i.id, sourceProduct: i.sourceProduct, status: i.status, expiresAt: i.expiresAt, lastConnectedAt: i.lastConnectedAt, lastError: i.lastError, paused: i.paused };
  }
}
