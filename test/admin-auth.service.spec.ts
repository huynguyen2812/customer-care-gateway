import { AdminAuthService } from '../src/admin/admin-auth.service';

describe('admin authentication', () => {
  const previous = { ...process.env };
  const prisma = { adminUser: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn(), count: jest.fn().mockResolvedValue(0), create: jest.fn() } } as any;
  afterEach(() => { process.env = { ...previous }; });

  it('creates a signed session and rejects tampering', async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
    process.env.ADMIN_PASSWORD_HASH = AdminAuthService.hashPassword('a-long-test-password');
    const service = new AdminAuthService(prisma);
    const result = await service.authenticate('admin', 'a-long-test-password', '127.0.0.1');
    expect(service.verifySession(result.session)).toMatchObject({ sub: 'admin', csrf: result.csrf });
    expect(() => service.verifySession(`${result.session}x`)).toThrow('Invalid admin session');
  });

  it('does not authenticate with a wrong password', async () => {
    process.env.ADMIN_SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
    process.env.ADMIN_PASSWORD_HASH = AdminAuthService.hashPassword('correct-password');
    await expect(new AdminAuthService(prisma).authenticate('admin', 'wrong-password', '127.0.0.2')).rejects.toThrow('Invalid username or password');
  });
});
