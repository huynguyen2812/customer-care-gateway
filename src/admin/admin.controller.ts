import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard, AdminRequest } from './admin-auth.guard';
import { AdminService } from './admin.service';
import { InstallationsService } from '../installations/installations.service';
import { PetclinicSyncService } from '../petclinic/petclinic-sync.service';

@Controller('admin')
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(private readonly admin: AdminService, private readonly installations: InstallationsService, private readonly petclinic: PetclinicSyncService) {}
  @Get('overview') overview() { return this.admin.overview(); }
  @Get('installations') listInstallations() { return this.admin.installations(); }
  @Post('installations') createInstallation(@Body() body: Record<string, unknown>, @Req() req: AdminRequest) { return this.installations.create(body, req.adminUser || 'admin-ui'); }
  @Get('jobs') jobs(@Query('take') take?: string) { return this.admin.jobs(Number(take || 100)); }
  @Post('jobs/:id/cancel') cancel(@Param('id') id: string, @Req() req: AdminRequest) { return this.admin.cancelJob(id, req.adminUser || 'admin-ui'); }
  @Get('templates') templates() { return this.admin.templates(); }
  @Post('installations/:id/templates') template(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AdminRequest) { return this.installations.upsertTemplate(id, body, req.adminUser || 'admin-ui'); }
  @Post('installations/:id/personal-zalo') zalo(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AdminRequest) { return this.installations.configurePersonalZalo(id, body, req.adminUser || 'admin-ui'); }
  @Post('installations/:id/petclinic') petclinicConfig(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AdminRequest) { return this.petclinic.configure(id, body, req.adminUser || 'admin-ui'); }
  @Post('installations/:id/petclinic/preview') petclinicPreview(@Param('id') id: string, @Req() req: AdminRequest) { return this.petclinic.sync(id, {}, req.adminUser || 'admin-ui'); }
  @Post('kill-switch') killSwitch(@Body() body: Record<string, unknown>, @Req() req: AdminRequest) { return this.installations.setKillSwitch(body.enabled === true, req.adminUser || 'admin-ui', body.reason ? String(body.reason) : undefined); }
  @Get('audit') audit(@Query('take') take?: string) { return this.admin.audits(Number(take || 100)); }
}
