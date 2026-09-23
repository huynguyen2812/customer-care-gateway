import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { PlatformControlGuard } from '../auth/platform-control.guard';
import { InstallationsService } from './installations.service';
import { PetclinicSyncService } from '../petclinic/petclinic-sync.service';

@Controller('installations')
@UseGuards(PlatformControlGuard)
export class InstallationsController {
  constructor(private readonly service: InstallationsService, private readonly petclinic: PetclinicSyncService) {}
  @Post() create(@Body() body: Record<string, unknown>, @Headers('x-platform-actor-id') actor = 'unknown') { return this.service.create(body, actor); }
  @Post(':id/rotate-key') rotate(@Param('id') id: string, @Headers('x-platform-actor-id') actor = 'unknown') { return this.service.rotate(id, actor); }
  @Post(':id/revoke') revoke(@Param('id') id: string, @Headers('x-platform-actor-id') actor = 'unknown') { return this.service.revoke(id, actor); }
  @Get(':id/status') status(@Param('id') id: string) { return this.service.status(id); }
  @Post(':id/templates') template(@Param('id') id: string, @Body() body: Record<string, unknown>, @Headers('x-platform-actor-id') actor = 'unknown') { return this.service.upsertTemplate(id, body, actor); }
  @Post(':id/personal-zalo') personalZalo(@Param('id') id: string, @Body() body: Record<string, unknown>, @Headers('x-platform-actor-id') actor = 'unknown') { return this.service.configurePersonalZalo(id, body, actor); }
  @Post(':id/petclinic') petclinicConnection(@Param('id') id: string, @Body() body: Record<string, unknown>, @Headers('x-platform-actor-id') actor = 'unknown') { return this.petclinic.configure(id, body, actor); }
  @Post(':id/petclinic/sync') petclinicSync(@Param('id') id: string, @Body() body: Record<string, unknown>, @Headers('x-platform-actor-id') actor = 'unknown') { return this.petclinic.sync(id, body, actor); }
  @Post('system/kill-switch') killSwitch(@Body() body: Record<string, unknown>, @Headers('x-platform-actor-id') actor = 'unknown') { return this.service.setKillSwitch(body.enabled === true, actor, body.reason ? String(body.reason) : undefined); }
}
