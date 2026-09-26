import type { CareJobStatus, ConsentStatus, InstallationSummary, SourceProduct } from './types'

const numberFmt = new Intl.NumberFormat('vi-VN')

const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh'
const formatter = (options: Intl.DateTimeFormatOptions, timeZone = DEFAULT_TIME_ZONE) => new Intl.DateTimeFormat('vi-VN', { ...options, timeZone })

export const fmtDateTime = (v?: string | null, timeZone = DEFAULT_TIME_ZONE) => (v ? formatter({ day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }, timeZone).format(new Date(v)) : '—')
export const fmtDate = (v?: string | null, timeZone = DEFAULT_TIME_ZONE) => (v ? formatter({ day: '2-digit', month: '2-digit', year: 'numeric' }, timeZone).format(new Date(v)) : '—')
export const fmtTime = (v?: string | null, timeZone = DEFAULT_TIME_ZONE) => (v ? formatter({ hour: '2-digit', minute: '2-digit' }, timeZone).format(new Date(v)) : '—')
export const fmtNumber = (v: number) => numberFmt.format(v)

/** Nguồn dữ liệu có thể mở rộng: thêm sản phẩm mới chỉ cần khai báo ở đây. */
export const SOURCE_FAMILIES = [
  { key: 'PETCLINIC', label: 'PETCLINIC', title: 'PETCLINIC — Phần mềm phòng khám', products: ['PETCLINIC_OPERATING', 'PETCLINIC_ESSENTIAL'], tone: 'brand' as const, configurable: true },
  { key: 'B2B_SALE', label: 'B2B SALE', title: 'B2B SALE — Kênh bán hàng đối tác', products: ['B2B_SALE'], tone: 'blue' as const, configurable: false },
]

export function sourceFamily(product: SourceProduct) {
  return SOURCE_FAMILIES.find((f) => f.products.includes(product)) || { key: product, label: product, title: product, products: [product], tone: 'gray' as const, configurable: false }
}

export function productLabel(product: SourceProduct): string {
  return ({ PETCLINIC_OPERATING: 'PETCLINIC', PETCLINIC_ESSENTIAL: 'PETCLINIC Essential', B2B_SALE: 'B2B SALE' } as Record<string, string>)[product] || product
}

/** Tên hiển thị của một kết nối dữ liệu (API chưa có trường tên riêng). */
export function connectionName(i: Pick<InstallationSummary, 'id' | 'sourceProduct'>): string {
  return `${productLabel(i.sourceProduct)} · ${i.id.slice(0, 8).toUpperCase()}`
}

export const JOB_STATUS: Record<CareJobStatus, { label: string; tone: Tone }> = {
  QUEUED: { label: 'Chờ gửi', tone: 'amber' },
  PROCESSING: { label: 'Đang gửi', tone: 'blue' },
  SENT: { label: 'Đã gửi', tone: 'green' },
  FAILED: { label: 'Thất bại', tone: 'red' },
  CANCELLED: { label: 'Đã hủy', tone: 'gray' },
  OPTED_OUT: { label: 'Khách từ chối', tone: 'gray' },
  ACCOUNT_RESTRICTED: { label: 'Tài khoản Zalo bị hạn chế', tone: 'red' },
  RECIPIENT_NOT_FOUND: { label: 'Không tìm thấy người nhận', tone: 'red' },
}

export const CONSENT: Record<ConsentStatus, { label: string; tone: Tone }> = {
  GRANTED: { label: 'Đồng ý', tone: 'green' },
  WITHDRAWN: { label: 'Từ chối', tone: 'red' },
  UNKNOWN: { label: 'Chưa rõ', tone: 'gray' },
}

export const EVENT_LABEL: Record<string, string> = {
  APPOINTMENT_REMINDER: 'Nhắc lịch hẹn',
  FOLLOW_UP_REMINDER: 'Nhắc tái khám',
  VACCINATION_REMINDER: 'Nhắc tiêm phòng',
  DEBT_DUE_REMINDER: 'Nhắc công nợ đến hạn',
  DEBT_OVERDUE_REMINDER: 'Nhắc công nợ quá hạn',
}
export const eventLabel = (v: string) => EVENT_LABEL[v] || v

const FAILURE_LABEL: Record<string, string> = {
  ADMIN_CANCELLED: 'Đã hủy thủ công',
  TENANT_CANCELLED: 'Doanh nghiệp đã hủy',
  TENANT_PAUSED: 'Doanh nghiệp đang tạm dừng tự động gửi',
  ENTITLEMENT_SUSPENDED: 'Gói dịch vụ đang tạm dừng',
  ENTITLEMENT_EXPIRED: 'Gói dịch vụ đã hết hạn',
  ENTITLEMENT_REVOKED: 'Quyền sử dụng đã bị thu hồi',
  ENTITLEMENT_INACTIVE: 'Gói dịch vụ chưa hoạt động',
  INSTALLATION_INACTIVE: 'Kết nối dữ liệu không hoạt động',
  SYSTEM_PAUSED: 'Dịch vụ gửi tin đang tạm ngưng',
  QUIET_HOURS: 'Đang trong giờ yên tĩnh',
  DAILY_QUOTA: 'Đã đạt hạn mức ngày',
  SOURCE_NO_LONGER_VALID: 'Lịch hẹn không còn hiệu lực ở nguồn',
  RECIPIENT_OPTED_OUT: 'Khách đã từ chối nhận tin',
  SEND_FAILED: 'Gửi không thành công',
  INSTALLATION_REVOKED: 'Kết nối dữ liệu đã bị thu hồi',
  SOURCE_RESCHEDULED: 'Lịch hẹn đã đổi giờ',
  SOURCE_STATUS_INELIGIBLE: 'Lịch hẹn đã hủy hoặc không còn hiệu lực',
  SOURCE_BRANCH_NOT_APPROVED: 'Chi nhánh chưa được duyệt',
  SOURCE_CONTACT_MISSING: 'Thiếu thông tin liên hệ',
  SOURCE_CONSENT_MISSING: 'Khách chưa đồng ý nhận tin',
  SOURCE_NOT_IN_PILOT_ALLOWLIST: 'Ngoài danh sách thử nghiệm',
  SOURCE_PHONE_INVALID: 'Số điện thoại không hợp lệ',
  CHANNEL_UNAVAILABLE: 'Dịch vụ gửi tin đang gặp sự cố',
  RATE_LIMITED: 'Vượt hạn mức gửi',
  ACCOUNT_RESTRICTED: 'Tài khoản Zalo bị hạn chế',
  RECIPIENT_NOT_FOUND: 'Không tìm thấy người nhận',
  NO_ELIGIBLE_ACCOUNT: 'Chưa có tài khoản Zalo sẵn sàng gửi',
  DELIVERY_UNCERTAIN: 'Chưa xác định được đã gửi hay chưa — cần kiểm tra thủ công',
  DELIVERY_RETRY_SAME_ATTEMPT: 'Đang xác nhận lại lượt gửi trước',
  SOURCE_VERIFY_UNAVAILABLE: 'Chưa kiểm tra được lịch hẹn ở nguồn',
  TEMPLATE_UNAVAILABLE: 'Mẫu tin không còn sử dụng được',
  RELOGIN_REQUIRED: 'Tài khoản Zalo cần đăng nhập lại',
  ACCOUNT_UNAVAILABLE: 'Tài khoản Zalo không sẵn sàng',
  ACCOUNT_PAUSED: 'Tài khoản Zalo đang tạm dừng',
  SENDER_UNREACHABLE: 'Không kết nối được dịch vụ gửi tin (chưa gửi)',
  SENDER_TIMEOUT: 'Dịch vụ gửi tin phản hồi quá lâu (chưa rõ kết quả)',
  CREDENTIAL_MISSING: 'Tài khoản Zalo chưa được cấu hình gửi',
  CHANNEL_NOT_SUPPORTED: 'Kênh gửi chưa được hỗ trợ',
  WORKER_RESTARTED_BEFORE_SEND: 'Tiến trình khởi động lại trước khi gửi (chưa gửi)',
  WORKER_RESTARTED_DURING_SEND: 'Tiến trình khởi động lại trong lúc gửi (chưa rõ kết quả)',
}
export const failureLabel = (code?: string | null) => (code ? FAILURE_LABEL[code] || code : '')

export const ACTION_LABEL: Record<string, string> = {
  INSTALLATION_CREATED: 'Tạo kết nối dữ liệu',
  CREDENTIAL_ROTATED: 'Đổi khóa kết nối dữ liệu',
  INSTALLATION_REVOKED: 'Thu hồi kết nối dữ liệu',
  MESSAGE_TEMPLATE_UPSERTED: 'Cập nhật mẫu tin nhắn',
  PERSONAL_ZALO_CONFIGURED: 'Cấu hình kênh Zalo',
  PETCLINIC_CONNECTION_CONFIGURED: 'Cấu hình kết nối PETCLINIC',
  PETCLINIC_SYNC_PREVIEWED: 'Xem trước dữ liệu PETCLINIC',
  PETCLINIC_SYNC_COMMITTED: 'Đồng bộ lịch hẹn PETCLINIC',
  CARE_JOB_CREATED: 'Tạo tác vụ chăm sóc',
  CARE_JOB_CANCELLED: 'Hủy tác vụ chăm sóc',
  CARE_JOB_SENT: 'Gửi tin thành công',
  CARE_JOB_FAILED: 'Gửi tin thất bại',
  OPT_OUT_RECORDED: 'Ghi nhận từ chối nhận tin',
  OPT_OUT_REMOVED: 'Gỡ khỏi danh sách từ chối',
  CRM_LOGIN: 'Đăng nhập VETCLINIC CRM',
  CRM_LOGOUT: 'Đăng xuất VETCLINIC CRM',
  CRM_AUTO_SEND_PAUSED: 'Tạm dừng tự động gửi',
  CRM_AUTO_SEND_RESUMED: 'Bật lại tự động gửi',
  CRM_SENDING_LIMITS_UPDATED: 'Cập nhật hạn mức và giờ yên tĩnh',
  PLATFORM_EVENT_INSTALLATION_UPSERTED: 'Nền tảng cấp/cập nhật quyền CRM',
  PLATFORM_EVENT_INSTALLATION_REVOKED: 'Nền tảng thu hồi quyền CRM',
  PLATFORM_EVENT_SUBSCRIPTION_ACTIVATED: 'Gói dịch vụ được kích hoạt',
  PLATFORM_EVENT_SUBSCRIPTION_CHANGED: 'Gói dịch vụ thay đổi',
  PLATFORM_EVENT_SUBSCRIPTION_SUSPENDED: 'Gói dịch vụ bị tạm dừng',
  PLATFORM_EVENT_SUBSCRIPTION_EXPIRED: 'Gói dịch vụ hết hạn',
  PLATFORM_EVENT_USER_PRODUCT_ACCESS_REVOKED: 'Thu hồi quyền truy cập của người dùng',
  SYSTEM_KILL_SWITCH_ENABLED: 'Dịch vụ gửi tin tạm ngưng',
  SYSTEM_KILL_SWITCH_DISABLED: 'Dịch vụ gửi tin hoạt động lại',
  ZALO_ACCOUNT_CREATED: 'Thêm tài khoản Zalo',
  ZALO_ACCOUNT_UPDATED: 'Cập nhật tài khoản Zalo',
  ZALO_ACCOUNT_PAUSED: 'Tạm dừng tài khoản Zalo',
  ZALO_ACCOUNT_RESUMED: 'Bật lại tài khoản Zalo',
  ZALO_ACCOUNT_DISCONNECTED: 'Ngắt kết nối tài khoản Zalo',
  ZALO_ACCOUNT_LOGIN_START: 'Bắt đầu đăng nhập Zalo',
  ZALO_ACCOUNT_CONNECTED: 'Tài khoản Zalo đã kết nối',
  ZALO_ROUTING_RULES_REPLACED: 'Cập nhật phân công tài khoản Zalo',
  ZALO_ACCOUNT_SELECTED: 'Chọn tài khoản Zalo để gửi',
  ZALO_ACCOUNT_RESELECTED: 'Chuyển sang tài khoản Zalo khác',
  ZALO_ACCOUNT_REJECTED_BEFORE_SEND: 'Tài khoản Zalo từ chối trước khi gửi',
  DELIVERY_UNCERTAIN: 'Chưa xác định kết quả gửi',
  CRM_TENANT_QUOTA_UPDATED: 'Cập nhật hạn mức doanh nghiệp',
}
export const actionLabel = (v: string) => ACTION_LABEL[v] || v

export const ACTOR_LABEL: Record<string, string> = {
  PLATFORM_ADMIN: 'Đội hỗ trợ VETCLINIC',
  ADMIN_UI: 'Đội hỗ trợ VETCLINIC',
  PLATFORM: 'Nền tảng VETCLINIC',
  CRM_USER: 'Người dùng CRM',
  INSTALLATION: 'Nguồn dữ liệu',
  SYSTEM: 'Hệ thống',
  WORKER: 'Tự động gửi',
}
export const actorLabel = (v: string) => ACTOR_LABEL[v] || v

export type Tone = 'brand' | 'green' | 'amber' | 'red' | 'blue' | 'gray'

/** Che số điện thoại: giữ 4 số đầu và 3 số cuối. */
export function maskPhone(v?: string | null): string {
  if (!v) return '—'
  const digits = v.replace(/\D/g, '')
  if (digits.length < 7) return '***'
  return `${digits.slice(0, 4)}***${digits.slice(-3)}`
}

const SENSITIVE_KEY = /secret|token|password|cookie|signature|signing|credential|apikey|api_key|session|imei|key$/i
const PHONE_LIKE = /(?:\+?84|0)\d{8,10}/g

/** Lớp phòng vệ phía giao diện: không bao giờ hiển thị khóa/bí mật và luôn che số điện thoại trong metadata. */
export function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return '…'
  if (typeof value === 'string') return value.replace(PHONE_LIKE, (m) => maskPhone(m))
  if (Array.isArray(value)) return value.map((x) => redactMetadata(x, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[đã ẩn]' : redactMetadata(v, depth + 1)]))
  }
  return value
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'QT'
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export const ZALO_STATUS: Record<string, { label: string; tone: Tone }> = {
  CONNECTED: { label: 'Đang hoạt động', tone: 'green' },
  PENDING_LOGIN: { label: 'Chờ đăng nhập', tone: 'gray' },
  CONNECTING: { label: 'Đang kết nối', tone: 'blue' },
  RELOGIN_REQUIRED: { label: 'Cần đăng nhập lại', tone: 'amber' },
  PAUSED: { label: 'Tạm dừng', tone: 'amber' },
  RATE_LIMITED: { label: 'Tạm vượt giới hạn gửi', tone: 'amber' },
  RESTRICTED: { label: 'Bị Zalo hạn chế', tone: 'red' },
  DISCONNECTED: { label: 'Đã ngắt kết nối', tone: 'gray' },
  ERROR: { label: 'Lỗi', tone: 'red' },
  REVOKED: { label: 'Đã thu hồi', tone: 'gray' },
}
/** Trạng thái hiển thị: tạm dừng thủ công ưu tiên hơn trạng thái kết nối. */
export const zaloStatus = (a: { status: string; paused: boolean }): { label: string; tone: Tone } => (a.paused ? { label: 'Tạm dừng', tone: 'amber' } : ZALO_STATUS[a.status] || { label: a.status, tone: 'gray' })
export const ATTEMPT_STATUS: Record<string, { label: string; tone: Tone }> = {
  RESERVED: { label: 'Đã giữ chỗ', tone: 'gray' },
  IN_FLIGHT: { label: 'Đang gửi', tone: 'blue' },
  SENT: { label: 'Đã gửi', tone: 'green' },
  REJECTED_BEFORE_SEND: { label: 'Chưa gửi (bị từ chối trước)', tone: 'amber' },
  UNKNOWN: { label: 'Chưa rõ kết quả', tone: 'red' },
}
