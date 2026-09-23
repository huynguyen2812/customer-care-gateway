// Lớp gọi API duy nhất của VETCLINIC CRM: chỉ gọi /api/v1/crm/*. Doanh nghiệp (tenant), người dùng và
// quyền do máy chủ suy ra từ phiên (cookie HttpOnly) — trình duyệt không gửi tenantId/userId.
// CSRF token chỉ giữ trong bộ nhớ; không dùng localStorage/sessionStorage cho token.
import type {
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
  if (res.status === 401 && path !== '/auth/me') {
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
