import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AdminAuthGuard, AdminRequest } from './admin-auth.guard';
import { AdminAuthService } from './admin-auth.service';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  async login(@Body() body: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.authenticate(String(body.username || ''), String(body.password || ''), req.ip || req.socket.remoteAddress || 'unknown');
    res.cookie('ccg_admin_session', result.session, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60_000 });
    return { authenticated: true, csrfToken: result.csrf };
  }

  @Get('setup-status') setupStatus() { return this.auth.setupStatus(); }

  @Post('setup')
  async setup(@Body() body: Record<string, unknown>) {
    await this.auth.setup(String(body.username || ''), String(body.password || ''), String(body.setupToken || ''));
    return { configured: true };
  }

  @Get('me')
  @UseGuards(AdminAuthGuard)
  me(@Req() req: AdminRequest) { return { authenticated: true, username: req.adminUser, csrfToken: req.adminCsrf }; }

  @Post('logout')
  @UseGuards(AdminAuthGuard)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('ccg_admin_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
    return { authenticated: false };
  }
}
