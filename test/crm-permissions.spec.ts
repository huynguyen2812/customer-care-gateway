import { entitlementUsable, mapPlatformRoles, permissionsFor, ROLE_PERMISSIONS } from '../src/crm/crm.constants';
import { maskPhone, redact } from '../src/crm/crm-redact';

describe('CRM role/permission matrix', () => {
  it('maps Platform vocabulary conservatively and never elevates unknown roles', () => {
    expect(mapPlatformRoles({ roles: ['ADMIN'] })).toEqual(['CRM_OWNER']);
    expect(mapPlatformRoles({ roles: ['TENANT_ADMIN'] })).toEqual(['CRM_OWNER']);
    expect(mapPlatformRoles({ roles: ['STAFF'] })).toEqual(['CRM_STAFF']);
    expect(mapPlatformRoles({ roles: [] })).toEqual(['CRM_VIEWER']);
    expect(mapPlatformRoles({ crmRoles: ['CRM_ADMIN'] })).toEqual(['CRM_ADMIN']);
    expect(mapPlatformRoles({ crmRoles: ['CRM_OWNER', 'SUPERADMIN'], roles: [] })).toEqual(['CRM_VIEWER']);
  });
  it('only the owner may replace source credentials; viewer is read-only', () => {
    expect(ROLE_PERMISSIONS.CRM_OWNER).toContain('crm.sources.manage');
    expect(ROLE_PERMISSIONS.CRM_ADMIN).not.toContain('crm.sources.manage');
    expect(ROLE_PERMISSIONS.CRM_ADMIN).toContain('crm.settings.manage');
    expect(permissionsFor(['CRM_VIEWER']).every((p) => p.endsWith('.read'))).toBe(true);
    expect(permissionsFor(['CRM_STAFF'])).toEqual(expect.arrayContaining(['crm.jobs.cancel']));
    expect(permissionsFor(['CRM_STAFF'])).not.toContain('crm.audit.read');
    expect(permissionsFor(['NOT_A_ROLE'])).toEqual([]);
  });
  it('entitlement is usable only for ACTIVE/TRIAL, unexpired, started and installation ACTIVE', () => {
    const base = { entitlementStatus: 'ACTIVE', entitlementExpiresAt: null, entitlementStartsAt: null, installationStatus: 'ACTIVE' };
    expect(entitlementUsable(base)).toBe(true);
    expect(entitlementUsable({ ...base, entitlementStatus: 'TRIAL' })).toBe(true);
    expect(entitlementUsable({ ...base, entitlementStatus: 'SUSPENDED' })).toBe(false);
    expect(entitlementUsable({ ...base, entitlementExpiresAt: new Date(Date.now() - 1) })).toBe(false);
    expect(entitlementUsable({ ...base, entitlementStartsAt: new Date(Date.now() + 60_000) })).toBe(false);
    expect(entitlementUsable({ ...base, installationStatus: 'REVOKED' })).toBe(false);
  });
  it('server-side redaction hides secrets and masks phone numbers', () => {
    expect(maskPhone('+84901234567')).toBe('0901***567');
    expect(redact({ apiToken: 'x', nested: { clientSecret: 'y', note: 'gọi 0901234567' }, count: 2 })).toEqual({ apiToken: '[đã ẩn]', nested: { clientSecret: '[đã ẩn]', note: 'gọi 0901***567' }, count: 2 });
  });
});
