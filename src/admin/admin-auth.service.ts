import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

type SessionPayload = { sub: string; exp: number; csrf: string };

@Injectable()
export class AdminAuthService {
  private readonly failures = new Map<string, { count: number; blockedUntil: number }>();
  constructor(private readonly prisma: PrismaService) {}

  private secret(): string {
    const secret = process.env.ADMIN_SESSION_SECRET || '';
    if (secret.length < 32) throw new ServiceUnavailableException('Admin login is not configured');
    return secret;
  }

  async authenticate(username: string, password: string, remoteAddress: string): Promise<{ session: string; csrf: string }> {
    const record = this.failures.get(remoteAddress);
    if (record && record.blockedUntil > Date.now()) throw new UnauthorizedException('Please wait before trying again');
    const user = await this.prisma.adminUser.findUnique({ where: { username } });
    const envUsername = process.env.ADMIN_USERNAME || 'admin';
    const envHash = process.env.ADMIN_PASSWORD_HASH || '';
    const valid = user ? user.active && this.verifyPassword(password, user.passwordHash) : username === envUsername && this.verifyPassword(password, envHash);
    if (!valid) {
      const count = (record?.count || 0) + 1;
      this.failures.set(remoteAddress, { count, blockedUntil: count >= 5 ? Date.now() + 15 * 60_000 : 0 });
      throw new UnauthorizedException('Invalid username or password');
    }
    this.failures.delete(remoteAddress);
    if (user) await this.prisma.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const payload: SessionPayload = { sub: username, exp: Date.now() + 8 * 60 * 60_000, csrf: randomBytes(24).toString('base64url') };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { session: `${body}.${this.sign(body)}`, csrf: payload.csrf };
  }

  async setup(username: string, password: string, setupToken: string): Promise<void> {
    if (await this.prisma.adminUser.count()) throw new ConflictException('Admin account is already configured');
    const expectedHash = process.env.ADMIN_SETUP_TOKEN_HASH || '';
    const suppliedHash = createHash('sha256').update(setupToken).digest('hex');
    if (!expectedHash || !this.safeEqual(suppliedHash, expectedHash)) throw new UnauthorizedException('Invalid setup token');
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(username) || password.length < 12 || password.length > 200) throw new ConflictException('Username or password does not meet requirements');
    await this.prisma.adminUser.create({ data: { username, passwordHash: AdminAuthService.hashPassword(password) } });
  }

  async setupStatus(): Promise<{ required: boolean }> { return { required: (await this.prisma.adminUser.count()) === 0 && !(process.env.ADMIN_PASSWORD_HASH || '') }; }

  verifySession(value: string): SessionPayload {
    const [body, signature] = value.split('.');
    if (!body || !signature || !this.safeEqual(signature, this.sign(body))) throw new UnauthorizedException('Invalid admin session');
    let payload: SessionPayload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload; }
    catch { throw new UnauthorizedException('Invalid admin session'); }
    if (!payload.sub || !payload.csrf || payload.exp <= Date.now()) throw new UnauthorizedException('Admin session expired');
    return payload;
  }

  static hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
    return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
  }

  private verifyPassword(password: string, encoded: string): boolean {
    const [algorithm, salt, hash] = encoded.split('$');
    if (algorithm !== 'scrypt' || !salt || !/^[0-9a-f]{128}$/i.test(hash || '')) return false;
    return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64));
  }

  private sign(body: string): string { return createHmac('sha256', this.secret()).update(body).digest('base64url'); }
  private safeEqual(left: string, right: string): boolean {
    const a = createHash('sha256').update(left).digest();
    const b = createHash('sha256').update(right).digest();
    return timingSafeEqual(a, b);
  }
}
