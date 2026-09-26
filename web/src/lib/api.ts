// Lớp gọi API duy nhất của VETCLINIC CRM: chỉ gọi /api/v1/crm/*. Doanh nghiệp (tenant), người dùng và
// quyền do máy chủ suy ra từ phiên (cookie HttpOnly) — trình duyệt không gửi tenantId/userId.
// CSRF token chỉ giữ trong bộ nhớ; không dùng localStorage/sessionStorage cho token.
import type {
  LocalCredential, LocalStatus, LocalUser, RevealedCredential, SourceConnectorInfo, SourceSyncResult, PlatformStatus, PlatformResetResponse, BuildInfo,
  AuditPage, CustomerDetail, CustomerPage, InstallationSummary, JobPage, CareJobDetail, Me, MessageTemplate, OptOut, Overview, Page, PetclinicPreview, Settings,
  ZaloAccountDetail, ZaloAccountList, ZaloRoutingRule,
} from './types'

let csrfToken = ''

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
}

/** Chức năng giao diện đã có nhưng máy chủ chưa cung cấp endpoint tương ứng. */
export class MissingEndpointError extends Error {
  constructor(readonly feature: string) {
    super(`Máy chủ chưa hỗ trợ chức năng "${feature}". Vui lòng liên hệ đội hỗ trợ VETCLINIC CRM.`)
  }
}

export const SESSION_EXPIRED_EVENT = 'vetclinic-crm:session-expired'
export const ACCESS_BLOCKED_EVENT = 'vetclinic-crm:access-blocked'
export const LOGIN_URL = '/api/v1/crm/auth/start'

/** Mã lỗi từ máy chủ → câu tiếng Việt cho khách hàng. */
export const REASON_VI: Record<string, string> = {
  SESSION_REQUIRED: 'Vui lòng đăng nhập để tiếp tục.',
  SESSION_EXPIRED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  ACCESS_REVOKED: 'Tài khoản của bạn không còn quyền truy cập VETCLINIC CRM.',
  ACCESS_DENIED: 'Tài khoản chưa được cấp quyền sử dụng VETCLINIC CRM cho doanh nghiệp này.',
  ENTITLEMENT_SUSPENDED: 'Gói VETCLINIC CRM của doanh nghiệp đang tạm dừng.',
  ENTITLEMENT_EXPIRED: 'Gói VETCLINIC CRM của doanh nghiệp đã hết hạn.',
  ENTITLEMENT_REVOKED: 'Quyền sử dụng VETCLINIC CRM của doanh nghiệp đã bị thu hồi.',
  ENTITLEMENT_INACTIVE: 'Gói VETCLINIC CRM của doanh nghiệp chưa hoạt động hoặc đã hết hiệu lực.',
  INSTALLATION_REVOKED: 'Kết nối VETCLINIC CRM của doanh nghiệp đã bị thu hồi.',
  CODE_INVALID: 'Liên kết đăng nhập đã hết hạn hoặc đã được dùng. Vui lòng đăng nhập lại.',
  STATE_INVALID: 'Phiên đăng nhập không khớp. Vui lòng bắt đầu đăng nhập lại từ đầu.',
  REDIRECT_MISMATCH: 'Cấu hình đăng nhập của doanh nghiệp chưa đúng. Vui lòng liên hệ đội hỗ trợ.',
  PLATFORM_UNAVAILABLE: 'Không kiểm tra được quyền truy cập lúc này. Vui lòng thử lại sau ít phút.',
  CRM_NOT_CONFIGURED: 'VETCLINIC CRM chưa được cấu hình đăng nhập. Vui lòng liên hệ đội hỗ trợ.',
  PERMISSION_DENIED: 'Bạn không có quyền thực hiện thao tác này.',
  CSRF_INVALID: 'Phiên làm việc không hợp lệ, vui lòng tải lại trang.',
  PLAN_LIMIT: 'Giá trị vượt giới hạn gói dịch vụ.',
  NOT_FOUND: 'Không tìm thấy dữ liệu.',
  SENDER_NOT_SUPPORTED: 'Dịch vụ gửi tin chưa hỗ trợ đăng nhập Zalo bằng mã QR. Đội hỗ trợ VETCLINIC sẽ kết nối tài khoản giúp bạn.',
  SENDER_UNAVAILABLE: 'Dịch vụ gửi tin đang bận. Vui lòng thử lại sau ít phút.',
  DUPLICATE_RULE: 'Có phân công bị trùng.',
  NO_CHANGE: 'Không có thay đổi nào.',
  RELOGIN_REQUIRED: 'Tài khoản Zalo cần đăng nhập lại trước khi bật lại. Tài khoản vẫn đang tạm dừng.',
  ACCOUNT_UNAVAILABLE: 'Dịch vụ gửi tin chưa sẵn sàng cho tài khoản này. Tài khoản vẫn đang tạm dừng.',
  SENDER_REGISTRATION_PENDING: 'Tài khoản chưa đăng ký được với dịch vụ gửi tin. Vui lòng bấm "Thử đăng ký lại".',
  SENDER_NOT_CONFIGURED: 'Dịch vụ gửi tin chưa được cấu hình. Vui lòng liên hệ đội hỗ trợ VETCLINIC.',
  LOGIN_FAILED: 'Tên đăng nhập hoặc mật khẩu không đúng, hoặc tài khoản đang bị khóa tạm.',
  LOGIN_THROTTLED: 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.',
  ALREADY_SET_UP: 'Máy này đã được thiết lập doanh nghiệp. Vui lòng đăng nhập.',
  SETUP_LOCAL_ONLY: 'Chỉ thiết lập được trên chính máy cài VETCLINIC CRM.',
  PASSWORD_LENGTH: 'Mật khẩu cần từ 10 đến 200 ký tự.',
  PASSWORD_TOO_SIMPLE: 'Mật khẩu không được chỉ gồm chữ số.',
  PASSWORD_CONTAINS_USERNAME: 'Mật khẩu không được chứa tên đăng nhập.',
  CURRENT_PASSWORD_WRONG: 'Mật khẩu hiện tại không đúng.',
  USERNAME_INVALID: 'Tên đăng nhập 3–80 ký tự: chữ thường, số, dấu chấm, gạch.',
  USERNAME_TAKEN: 'Tên đăng nhập đã tồn tại.',
  OWNER_PROTECTED: 'Không thể sửa vai trò hoặc khóa chủ doanh nghiệp.',
  SOURCE_URL_INSECURE: 'Địa chỉ hệ thống nguồn phải dùng HTTPS (hoặc chạy trên chính máy này).',
  SOURCE_URL_INVALID: 'Địa chỉ hệ thống nguồn không hợp lệ.',
  SOURCE_UNAVAILABLE: 'Không kết nối được hệ thống nguồn. Tin sẽ không được gửi cho tới khi kết nối lại.',
  SOURCE_CONNECTION_INACTIVE: 'Kết nối nguồn dữ liệu đang tắt.',
  BRANCH_REQUIRED: 'Cần ít nhất một chi nhánh được duyệt.',
  BRANCH_NOT_LICENSED: 'Chi nhánh này chưa được Platform cấp cho nguồn dữ liệu này.',
  PLATFORM_CONFIG_EXPIRED: 'Cấu hình cấp phép từ Platform đã hết hạn; tin được giữ lại cho tới khi nhận cấu hình mới.',
  PLATFORM_ACTIVATION_REQUIRED: 'Máy chưa được kích hoạt với Platform. Nhập mã kích hoạt ở mục "Kết nối Platform" để bắt đầu gửi tin.',
  SOURCE_NOT_LICENSED: 'Gói Platform chưa cấp loại nguồn dữ liệu này.',
  SOURCE_SCOPE_REQUIRED: 'Chưa chọn loại hệ thống nguồn nên chưa xác định được phạm vi giấy phép.',
  SOURCE_KIND_REQUIRED: 'Chọn loại hệ thống nguồn (PETCLINIC, B2B SALE hoặc hệ thống khác).',
  SOURCE_KIND_CHANGED: 'Loại hệ thống nguồn đã đổi; tin tạo theo loại cũ đã được hủy.',
  BRANCH_LIMIT_EXCEEDED: 'Số chi nhánh vượt quá hạn mức của gói.',
  ACTIVATION_CODE_FORMAT: 'Mã kích hoạt không đúng định dạng (ví dụ ABCD-EFGH-JKLM).',
  ACTIVATION_CODE_INVALID: 'Mã kích hoạt không đúng.',
  ACTIVATION_CODE_EXPIRED: 'Mã kích hoạt đã hết hạn (hiệu lực 10 phút). Xin mã mới trên Platform.',
  ACTIVATION_CODE_USED: 'Mã kích hoạt đã được dùng cho một máy khác.',
  ACTIVATION_WRONG_PRODUCT: 'Mã này không dành cho VETCLINIC CRM.',
  ACTIVATION_WRONG_TENANT: 'Mã này không thuộc doanh nghiệp của bạn.',
  ACTIVATION_IN_PROGRESS: 'Đang có thao tác kích hoạt/phục hồi khác, vui lòng đợi rồi thử lại.',
  ACTIVATION_RETRY_SAME_CODE: 'Máy đang chờ hoàn tất kích hoạt bằng mã trước. Nhập lại đúng mã đó; nếu mã đã hết hạn, dùng mục Phục hồi kích hoạt.',
  ACTIVATION_RECOVERY_REQUIRED: 'Mã kích hoạt cũ không dùng được nữa. Làm theo mục Phục hồi kích hoạt rồi nhập mã mới.',
  DEVICE_REVOKED: 'Platform đã thu hồi thiết bị này. Cần phục hồi kích hoạt và nhập mã mới.',
  BRANCH_MAPPING_REQUIRED: 'Mã chi nhánh chưa được ánh xạ sang mã chi nhánh Platform (UUID).',
  ALREADY_PAIRED: 'Máy này đã được ghép với Platform.',
  PLATFORM_NOT_CONFIGURED: 'Bản cài này chưa có cấu hình Platform.',
  PLATFORM_UNREACHABLE: 'Không kết nối được Platform. Kiểm tra Internet rồi thử lại.',
  DEVICE_KEY_UNAVAILABLE: 'Cần chạy bộ cài phiên bản mới để bật kết nối Platform.',
  CONFIRM_REQUIRED: 'Chưa xác nhận: cần gõ đúng NGAT GHEP NOI.',
}
const BLOCKING = new Set(['ENTITLEMENT_SUSPENDED', 'ENTITLEMENT_EXPIRED', 'ENTITLEMENT_REVOKED', 'ENTITLEMENT_INACTIVE', 'INSTALLATION_REVOKED'])

async function request<T>(path: string, options: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
  const method = options.method || 'GET'
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (csrfToken && !['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = csrfToken
  const qs = options.query ? Object.entries(options.query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : ''
  let res: Response
  try {
    res = await fetch(`/api/v1/crm${path}${qs ? `?${qs}` : ''}`, { method, headers, credentials: 'same-origin', body: options.body === undefined ? undefined : JSON.stringify(options.body) })
  } catch {
    throw new ApiError('Không kết nối được máy chủ. Kiểm tra mạng và thử lại.', 0)
  }
  const data = await res.json().catch(() => ({})) as { message?: string | string[] | { code?: string; message?: string }; code?: string }
  const code = data.code || (typeof data.message === 'object' && !Array.isArray(data.message) ? data.message?.code : undefined)
  if (res.status === 401 && path !== '/auth/me' && !path.startsWith('/auth/local/')) {
    csrfToken = ''
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: code || 'SESSION_EXPIRED' }))
  }
  if (res.status === 403 && code && BLOCKING.has(code)) window.dispatchEvent(new CustomEvent(ACCESS_BLOCKED_EVENT, { detail: code }))
  if (!res.ok) {
    const raw = typeof data.message === 'string' ? data.message : Array.isArray(data.message) ? data.message.join(', ') : undefined
    const msg = (code && REASON_VI[code]) || raw || (res.status >= 500 ? 'Dịch vụ đang gặp sự cố. Vui lòng thử lại sau.' : `Lỗi HTTP ${res.status}`)
    throw new ApiError(msg, res.status, code)
  }
  return data as T
}

type Q = Record<string, string | number | undefined>

export const api = {
  async me() { const out = await request<Me>('/auth/me'); csrfToken = out.csrfToken; return out },
  async logout() { try { await request('/auth/logout', { method: 'POST', body: {} }) } finally { csrfToken = '' } },

  // ---------- bản chạy trên PC ----------
  /** null = bản VPS (đăng nhập qua Platform). */
  async localStatus(): Promise<LocalStatus | null> {
    try { return await request<LocalStatus>('/auth/local/status') } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e }
  },
  localSetup: (body: { businessName: string; username: string; displayName: string; password: string }) =>
    request<{ tenant: { id: string; name: string }; apiCredential: RevealedCredential }>('/auth/local/setup', { method: 'POST', body }),
  localLogin: (username: string, password: string) => request<{ authenticated: boolean }>('/auth/local/login', { method: 'POST', body: { username, password } }),
  changePassword: (currentPassword: string, newPassword: string) => request<{ changed: boolean }>('/auth/local/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
  localUsers: () => request<LocalUser[]>('/local/users'),
  createLocalUser: (body: { username: string; displayName: string; role: string; password: string }) => request<LocalUser>('/local/users', { method: 'POST', body }),
  updateLocalUser: (id: string, body: { displayName?: string; role?: string; active?: boolean; password?: string }) => request<LocalUser>(`/local/users/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  apiCredentials: () => request<{ installationId: string; credentials: LocalCredential[] }>('/local/api-credentials'),
  rotateApiCredential: () => request<RevealedCredential & { previousValidUntil: string }>('/local/api-credentials/rotate', { method: 'POST', body: {} }),
  revokeApiCredential: (clientId: string) => request<{ clientId: string }>(`/local/api-credentials/${encodeURIComponent(clientId)}/revoke`, { method: 'POST', body: {} }),
  sourceConnector: () => request<SourceConnectorInfo>('/local/source-connector'),
  saveSourceConnector: (body: Record<string, unknown>) => request<SourceConnectorInfo>('/local/source-connector', { method: 'PUT', body }),
  previewAppointments: () => request<SourceSyncResult>('/local/source-connector/appointments/preview', { method: 'POST', body: {} }),
  syncAppointments: () => request<SourceSyncResult>('/local/source-connector/appointments/sync', { method: 'POST', body: {} }),
  platformStatus: () => request<PlatformStatus>('/local/platform'),
  platformActivate: (activationCode: string) => request<PlatformStatus>('/local/platform/activate', { method: 'POST', body: { activationCode } }),
  platformSync: () => request<PlatformStatus>('/local/platform/sync', { method: 'POST', body: {} }),
  platformUnpair: (confirm: string) => request<PlatformResetResponse>('/local/platform/unpair', { method: 'POST', body: { confirm } }),
  version: () => request<BuildInfo>('/local/version'),
  emergencyStop: () => request<{ enabled: boolean; reason: string | null; changedAt: string | null }>('/local/emergency-stop'),
  setEmergencyStop: (enabled: boolean, reason: string) => request<{ enabled: boolean }>('/local/emergency-stop', { method: 'PUT', body: { enabled, reason } }),

  overview: (period: string) => request<Overview>('/overview', { query: { period } }),
  installations: () => request<InstallationSummary[]>('/installations'),
  configurePetclinic: (installationId: string, body: Record<string, unknown>) =>
    request<{ active: boolean; branchCount: number; pilotAllowCount: number }>(`/installations/${encodeURIComponent(installationId)}/petclinic`, { method: 'POST', body }),
  previewPetclinic: (installationId: string) => request<PetclinicPreview>(`/installations/${encodeURIComponent(installationId)}/petclinic/preview`, { method: 'POST', body: {} }),

  customers: (query: Q) => request<CustomerPage>('/customers', { query }),
  customer: (id: string) => request<CustomerDetail>(`/customers/${encodeURIComponent(id)}`),

  templates: () => request<MessageTemplate[]>('/templates'),
  saveTemplate: (body: { installationId: string; code: string; body: string; allowedVariables: string[]; active: boolean }) =>
    request<{ id: string; code: string; active: boolean }>('/templates', { method: 'POST', body }),
  setTemplateActive: (id: string, active: boolean) => request<{ id: string; active: boolean }>(`/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: { active } }),

  jobs: (query: Q) => request<JobPage>('/jobs', { query }),
  job: (id: string) => request<CareJobDetail>(`/jobs/${encodeURIComponent(id)}`),
  cancelJobs: (ids: string[]) => request<{ results: { id: string; cancelled: boolean; reason?: string }[]; cancelled: number }>('/jobs/cancel', { method: 'POST', body: { ids } }),

  optOuts: (query: Q) => request<Page<OptOut>>('/opt-outs', { query }),
  removeOptOut: (id: string, reason: string) => request<{ id: string; removed: boolean }>(`/opt-outs/${encodeURIComponent(id)}`, { method: 'DELETE', body: { reason } }),

  audit: (query: Q) => request<AuditPage>('/audit', { query }),
  settings: () => request<Settings>('/settings'),
  updateSettings: (body: { autoSendPaused?: boolean; tenantDailyQuota?: number | null; installations?: { id: string; dailyQuota?: number; quietHoursStart?: string; quietHoursEnd?: string }[] }) =>
    request<{ updated: string[] }>('/settings', { method: 'PATCH', body }),

  zaloAccounts: () => request<ZaloAccountList>('/zalo-accounts'),
  zaloAccount: (id: string) => request<ZaloAccountDetail>(`/zalo-accounts/${encodeURIComponent(id)}`),
  createZaloAccount: (body: { displayName: string; dailyQuota?: number; priority?: number; isDefault?: boolean }) => request<ZaloAccountDetail>('/zalo-accounts', { method: 'POST', body }),
  updateZaloAccount: (id: string, body: { displayName?: string; dailyQuota?: number; priority?: number; isDefault?: true }) => request<ZaloAccountDetail>(`/zalo-accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  registerZaloSender: (id: string) => request<{ id: string; registered: boolean }>(`/zalo-accounts/${encodeURIComponent(id)}/sender/register`, { method: 'POST', body: {} }),
  pauseZaloAccount: (id: string) => request<{ id: string; paused: boolean }>(`/zalo-accounts/${encodeURIComponent(id)}/pause`, { method: 'POST', body: {} }),
  resumeZaloAccount: (id: string) => request<{ id: string; paused: boolean }>(`/zalo-accounts/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} }),
  disconnectZaloAccount: (id: string) => request<{ id: string; status: string; senderSessionTerminated: boolean }>(`/zalo-accounts/${encodeURIComponent(id)}/disconnect`, { method: 'POST', body: {} }),
  zaloLoginStart: (id: string) => request<{ loginId: string; qrImage: string; expiresAt: string }>(`/zalo-accounts/${encodeURIComponent(id)}/login/start`, { method: 'POST', body: {} }),
  zaloLoginStatus: (id: string, loginId: string) => request<{ status: 'PENDING' | 'SCANNED' | 'CONNECTED' | 'EXPIRED' | 'FAILED' }>(`/zalo-accounts/${encodeURIComponent(id)}/login/status`, { query: { loginId } }),
  zaloRules: () => request<ZaloRoutingRule[]>('/zalo-routing-rules'),
  replaceZaloRules: (rules: Omit<ZaloRoutingRule, 'id'>[]) => request<ZaloRoutingRule[]>('/zalo-routing-rules', { method: 'PUT', body: { rules } }),
}
