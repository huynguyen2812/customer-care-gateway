// Mã kích hoạt Platform chỉ nằm trong state React của màn "Kết nối Platform" (bộ nhớ trang). Không bao giờ ghi vào
// localStorage/sessionStorage/IndexedDB/cookie/URL. Module thuần (không React/DOM) để kiểm thử được.

/** Chuẩn hóa khi gõ/dán: chữ hoa, bỏ khoảng trắng thừa ở hai đầu. Không tự gửi gì. */
export function normalizeActivationCodeInput(raw: string): string {
  return raw.toUpperCase().replace(/^\s+|\s+$/g, '').slice(0, 40)
}

/**
 * Sau các kết cục này mã cũ không còn dùng được, nên xóa khỏi state: Platform báo hết hạn, thiết bị bị thu hồi, máy
 * yêu cầu phục hồi, hoặc Platform từ chối rõ ràng. Mất phản hồi / lỗi mạng thì GIỮ lại (chỉ trong bộ nhớ trang) để
 * người dùng thử lại đúng mã đó — việc này không đụng tới binding PENDING ở máy chủ.
 */
const CLEAR_ON_ERROR = new Set([
  'ACTIVATION_CODE_EXPIRED', 'ACTIVATION_RECOVERY_REQUIRED', 'DEVICE_REVOKED',
  'ACTIVATION_CODE_INVALID', 'ACTIVATION_CODE_USED', 'ACTIVATION_WRONG_PRODUCT', 'ACTIVATION_WRONG_TENANT', 'PLAN_NOT_ACTIVE',
])
export function shouldClearCodeAfterError(code: string | null | undefined): boolean {
  return !!code && CLEAR_ON_ERROR.has(code)
}

/** Trạng thái máy chủ mà mã cũ vô dụng: đã kích hoạt, cần phục hồi, hoặc đã ngắt ghép/thu hồi. */
export function shouldClearCodeForState(deviceStatus: string | null | undefined, activationState: string | null | undefined): boolean {
  return deviceStatus === 'ACTIVE' || deviceStatus === 'UNPAIRED' || deviceStatus === 'REVOKED' || activationState === 'RECOVERY_REQUIRED'
}

/**
 * Thuộc tính cho ô nhập mã: hạn chế trình duyệt/trình quản lý mật khẩu tự điền hoặc lưu mã. Đây là gợi ý cho trình
 * duyệt, không phải bảo đảm tuyệt đối (một số trình quản lý mật khẩu có thể bỏ qua).
 */
export function activationInputProps(fieldName: string) {
  return {
    name: fieldName, autoComplete: 'off', autoCorrect: 'off', autoCapitalize: 'characters', spellCheck: false, inputMode: 'text' as const,
    'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other',
  }
}
