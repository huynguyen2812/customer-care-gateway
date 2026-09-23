// Kiểu dữ liệu phản ánh đúng response của /api/v1/crm/* (src/crm/crm-data.service.ts).

export type SourceProduct = 'PETCLINIC_OPERATING' | 'PETCLINIC_ESSENTIAL' | 'B2B_SALE' | (string & {})
export type InstallationStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'ERROR'
export type CareJobStatus =
  | 'QUEUED' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED'
  | 'OPTED_OUT' | 'ACCOUNT_RESTRICTED' | 'RECIPIENT_NOT_FOUND'
export type ConsentStatus = 'UNKNOWN' | 'GRANTED' | 'WITHDRAWN'
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number }

export type Permission =
  | 'crm.dashboard.read' | 'crm.customers.read' | 'crm.customers.manage' | 'crm.sources.read' | 'crm.sources.manage'
  | 'crm.zalo.read' | 'crm.zalo.manage' | 'crm.templates.read' | 'crm.templates.manage' | 'crm.jobs.read' | 'crm.jobs.cancel'
  | 'crm.optouts.read' | 'crm.optouts.manage' | 'crm.audit.read' | 'crm.settings.read' | 'crm.settings.manage'

export interface Me {
  user: { platformUserId: string; displayName: string | null; username: string | null }
  tenant: { id: string; name: string | null }
  roles: string[]
  permissions: Permission[]
  csrfToken: string
  expiresAt: string
  entitlement: { status: string; planCode: string | null; expiresAt: string | null }
  platformAccountUrl: string | null
}

export interface Overview {
  period: string
  counts: { connections: number; queued: number; processing: number; sent: number; failed: number; cancelled: number; optedOut: number; upcoming: number }
  series: { date: string; sent: number; failed: number }[]
  upcoming: { id: string; externalReferenceId: string; eventType: string; scheduledAt: string; status: CareJobStatus }[]
  recent: { id: string; action: string; result: string; actorType: string; actorId: string | null; createdAt: string }[]
  autoSend: { paused: boolean; workerRunning: boolean }
  sendingService: { available: boolean }
  entitlement: { status: string; usable: boolean; planCode: string | null; expiresAt: string | null }
}

export interface InstallationSummary {
  id: string
  sourceProduct: SourceProduct
  status: InstallationStatus
  paused: boolean
  dailyQuota: number
  quietHoursStart: string
  quietHoursEnd: string
  timezone: string
  lastConnectedAt: string | null
  lastError: string | null
  createdAt: string
  zaloAccounts: {
    id: string
    channel: ZaloChannelType
    displayName: string | null
    status: ZaloAccountStatus
    paused: boolean
    isDefault: boolean
    lastConnectedAt: string | null
    lastError: string | null
  }[]
  petclinicConnection: {
    apiBaseUrl: string
    apiTenantId: string
    allowedBranchIds: string[]
    reminderLeadMinutes: number
    active: boolean
    lastSyncAt: string | null
    lastSyncStatus: string | null
    lastError: string | null
  } | null
  _count: { jobs: number; templates: number; optOuts: number }
}

export type ZaloChannelType = 'MOCK' | 'PERSONAL_ZALO' | 'ZNS'
export type ZaloAccountStatus = 'PENDING_LOGIN' | 'CONNECTING' | 'CONNECTED' | 'RELOGIN_REQUIRED' | 'PAUSED' | 'RATE_LIMITED' | 'RESTRICTED' | 'DISCONNECTED' | 'ERROR' | 'REVOKED'
export interface ZaloAssignment { id: string; installationId: string | null; branchId: string | null; eventType: string | null; priority: number; active: boolean }
export interface ZaloAccount {
  id: string
  channel: ZaloChannelType
  displayName: string
  phoneMasked: string | null
  status: ZaloAccountStatus
  paused: boolean
  pausedAt: string | null
  priority: number
  isDefault: boolean
  dailyQuota: number
  timezone: string
  sentToday: number
  queuedJobs: number
  lastConnectedAt: string | null
  lastActiveAt: string | null
  lastError: string | null
  createdAt: string
  usable: boolean
  unavailableReason: string | null
  capabilities: { qrLogin: boolean; recipientPreflight: boolean; idempotentSend: boolean; remoteControl: boolean }
  assignments: ZaloAssignment[]
}
export type ZaloAccountDetail = ZaloAccount & { recentAttempts: { id: string; careJobId: string; attemptNumber: number; status: DeliveryAttemptStatus; outcomeCode: string | null; createdAt: string; finishedAt: string | null }[] }
export type ZaloAccountList = { accounts: ZaloAccount[]; tenantDailyLimit: number | null; maxAccountDailyWithoutPlan: number }
export interface ZaloRoutingRule { id: string; zaloAccountId: string; installationId: string | null; branchId: string | null; eventType: string | null; priority: number; active: boolean }
export type DeliveryAttemptStatus = 'RESERVED' | 'IN_FLIGHT' | 'SENT' | 'REJECTED_BEFORE_SEND' | 'UNKNOWN'
export interface DeliveryAttempt { id: string; attemptNumber: number; zaloAccountId: string; accountName: string; status: DeliveryAttemptStatus; outcomeCode: string | null; providerMessageId: string | null; sendCount: number; startedAt: string | null; finishedAt: string | null; createdAt: string }

export interface CareJob {
  id: string
  installationId: string
  externalReferenceId: string
  sourceProduct: SourceProduct
  eventType: string
  templateCode: string
  scheduledAt: string
  consentStatus: ConsentStatus
  status: CareJobStatus
  attempts: number
  failureCode: string | null
  failureReason: string | null
  sentAt: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
  branchId?: string | null
  selectedZaloAccountId?: string | null
  selectedZaloAccountName?: string | null
  selectedChannel?: ZaloChannelType | null
}
export type CareJobDetail = CareJob & { deliveryAttempts: DeliveryAttempt[] }
export type JobStats = { pending: number; processing: number; sent: number; failed: number; cancelled: number }
export type JobPage = Page<CareJob> & { stats: JobStats; templateCodes: string[] }

export interface MessageTemplate {
  id: string
  installationId: string
  code: string
  body: string
  allowedVariables: string[]
  active: boolean
  updatedAt: string
}

export interface AuditEntry {
  id: string
  installationId: string | null
  actorType: string
  actorId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  result: string
  reason: string | null
  metadata: unknown
  createdAt: string
}
export type AuditPage = Page<AuditEntry> & { actions: string[] }

export interface Customer {
  id: string
  installationId: string
  name: string
  maskedPhone: string | null
  sourceProduct: SourceProduct
  consentStatus: ConsentStatus
  optedOut: boolean
  careCount: number
  lastInteractionAt: string
}
export type CustomerPage = Page<Customer> & { stats: { total: number; granted: number; optedOut: number } }
export type CustomerDetail = Customer & { history: Pick<CareJob, 'id' | 'externalReferenceId' | 'eventType' | 'templateCode' | 'scheduledAt' | 'status' | 'sentAt' | 'failureCode' | 'createdAt'>[] }

export interface OptOut { id: string; installationId: string; maskedPhone: string | null; source: string; reason: string | null; createdAt: string }

export interface Settings {
  autoSendPaused: boolean
  autoSendPausedAt: string | null
  tenantDailyQuota: number | null
  timezone: string
  entitlement: { status: string; usable: boolean; planCode: string | null; expiresAt: string | null; dailyQuotaMax: number | null }
  sendingService: { available: boolean }
  workerRunning: boolean
  installations: { id: string; sourceProduct: SourceProduct; status: InstallationStatus; dailyQuota: number; quietHoursStart: string; quietHoursEnd: string; timezone: string }[]
}

export interface PetclinicPreview {
  dryRun: boolean
  scanned: number
  eligible: number
  created: number
  cancelled: number
  skippedByReason: Record<string, number>
}
