import { platformWebOrigin } from './crm-auth.controller';

describe('platformWebOrigin', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOrigin = process.env.PLATFORM_WEB_ORIGIN;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.PLATFORM_WEB_ORIGIN = originalOrigin;
  });

  it('chỉ chấp nhận cổng admin.vetclinic.vn trên production', () => {
    process.env.NODE_ENV = 'production';
    process.env.PLATFORM_WEB_ORIGIN = 'https://admin.vetclinic.vn/';
    expect(platformWebOrigin()).toBe('https://admin.vetclinic.vn');

    process.env.PLATFORM_WEB_ORIGIN = 'https://b2b.vetclinic.vn';
    expect(platformWebOrigin()).toBe('');
  });

  it('cho phép Platform giả lập qua HTTP ngoài production', () => {
    process.env.NODE_ENV = 'test';
    process.env.PLATFORM_WEB_ORIGIN = 'http://platform.test';
    expect(platformWebOrigin()).toBe('http://platform.test');
  });
});
