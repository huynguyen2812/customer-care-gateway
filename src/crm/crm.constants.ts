export const CRM_PRODUCT_CODE = 'CUSTOMER_CARE_CRM';
export const CRM_SESSION_COOKIE = 'vc_crm_session';
export const CRM_SESSION_COOKIE_SECURE = '__Host-vc_crm_session';
export const CRM_STATE_COOKIE = 'vc_crm_sso_state';

export const CRM_ROLES = ['CRM_OWNER', 'CRM_ADMIN', 'CRM_STAFF', 'CRM_VIEWER'] as const;
export type CrmRole = (typeof CRM_ROLES)[number];

export const CRM_PERMISSIONS = [
  'crm.dashboard.read',
  'crm.customers.read', 'crm.customers.manage',
  'crm.sources.read', 'crm.sources.manage',
  'crm.zalo.read', 'crm.zalo.manage',
  'crm.templates.read', 'crm.templates.manage',
  'crm.jobs.read', 'crm.jobs.create', 'crm.jobs.cancel',
  'crm.optouts.read', 'crm.optouts.manage',
  'crm.audit.read',
  'crm.settings.read', 'crm.settings.manage',
  // Standalone PC edition only (local staff accounts); owner-only.
  'crm.users.manage',
] as const;
export type CrmPermission = (typeof CRM_PERMISSIONS)[number];

const READ: CrmPermission[] = ['crm.dashboard.read', 'crm.customers.read', 'crm.templates.read', 'crm.jobs.read', 'crm.optouts.read', 'crm.settings.read'];

/**
 * Role → permission matrix. Every role is tenant-scoped: no role grants Platform-wide actions
 * (kill switch, installation credentials, other tenants). CRM_OWNER alone may replace the stored
 * source credentials; CRM_ADMIN manages daily operations.
 */
export const ROLE_PERMISSIONS: Record<CrmRole, readonly CrmPermission[]> = {
  CRM_OWNER: CRM_PERMISSIONS,
  CRM_ADMIN: CRM_PERMISSIONS.filter((p) => p !== 'crm.sources.manage' && p !== 'crm.users.manage'),
  CRM_STAFF: [...READ, 'crm.sources.read', 'crm.zalo.read', 'crm.jobs.create', 'crm.jobs.cancel'],
  CRM_VIEWER: READ,
};

export function permissionsFor(roles: readonly string[]): CrmPermission[] {
  const out = new Set<CrmPermission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role as CrmRole] || []) out.add(p);
  return [...out].sort();
}

/**
 * Maps Platform claims to CRM roles. An explicit `crmRoles` claim (requested in the Platform
 * handoff) wins when it only contains known CRM roles. Otherwise the existing Platform vocabulary
 * is mapped conservatively: tenant admin → CRM_OWNER, anyone else → CRM_STAFF. Unknown input yields
 * CRM_VIEWER (least privilege), never an elevated role.
 */
export function mapPlatformRoles(claims: Record<string, unknown>): CrmRole[] {
  if (Array.isArray(claims.crmRoles)) {
    const explicit = claims.crmRoles.filter((r): r is CrmRole => CRM_ROLES.includes(r as CrmRole));
    if (explicit.length && explicit.length === claims.crmRoles.length) return [...new Set(explicit)];
  }
  const roles = Array.isArray(claims.roles) ? claims.roles.map(String) : [];
  if (roles.includes('ADMIN') || roles.includes('TENANT_ADMIN')) return ['CRM_OWNER'];
  if (roles.includes('STAFF') || roles.length) return ['CRM_STAFF'];
  return ['CRM_VIEWER'];
}

/** Platform TenantProduct statuses that allow using the product. */
export const USABLE_ENTITLEMENTS = new Set(['TRIAL', 'ACTIVE']);

export function entitlementUsable(tenant: { entitlementStatus: string; entitlementExpiresAt: Date | null; entitlementStartsAt: Date | null; installationStatus: string; deletionRequestId?: string | null }, now = new Date()): boolean {
  if (tenant.deletionRequestId) return false;
  if (tenant.installationStatus !== 'ACTIVE') return false;
  if (!USABLE_ENTITLEMENTS.has(tenant.entitlementStatus)) return false;
  if (tenant.entitlementExpiresAt && tenant.entitlementExpiresAt <= now) return false;
  if (tenant.entitlementStartsAt && tenant.entitlementStartsAt > now) return false;
  return true;
}

/** Reason code the UI can explain in customer language. */
export function entitlementDenyCode(tenant: { entitlementStatus: string; entitlementExpiresAt: Date | null; installationStatus: string; deletionRequestId?: string | null }, now = new Date()): string {
  if (tenant.deletionRequestId) return 'TENANT_DELETION_PENDING';
  if (tenant.installationStatus === 'REVOKED') return 'INSTALLATION_REVOKED';
  if (tenant.entitlementStatus === 'SUSPENDED') return 'ENTITLEMENT_SUSPENDED';
  if (tenant.entitlementStatus === 'EXPIRED' || (tenant.entitlementExpiresAt && tenant.entitlementExpiresAt <= now)) return 'ENTITLEMENT_EXPIRED';
  if (tenant.entitlementStatus === 'TERMINATED' || tenant.entitlementStatus === 'REVOKED') return 'ENTITLEMENT_REVOKED';
  return 'ENTITLEMENT_INACTIVE';
}
