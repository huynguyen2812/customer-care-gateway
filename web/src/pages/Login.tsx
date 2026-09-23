import { AlertCircle, ArrowRight, Info, LogIn, PawPrint, ShieldCheck } from 'lucide-react'
import { LOGIN_URL, REASON_VI } from '@/lib/api'

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F6F8F8] flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-[380px]">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-[#0F766E] flex items-center justify-center mb-3"><PawPrint size={24} color="white" aria-hidden /></div>
          <div className="text-[22px] font-bold text-[#172B2A]">VETCLINIC CRM</div>
          <div className="text-[13px] text-[#6B7280] mt-0.5">Chăm sóc khách hàng</div>
        </div>
        <div className="bg-white border border-[#E2E8F0] rounded-[10px] shadow-[0_1px_4px_rgba(0,0,0,0.06)] p-7">{children}</div>
        <p className="text-center text-[11px] text-[#9CA3AF] mt-5">crm.vetclinic.vn · Không chia sẻ thông tin đăng nhập</p>
      </div>
    </div>
  )
}

/**
 * Đăng nhập khách hàng chỉ qua tài khoản VETCLINIC (Platform). CRM không nhận mật khẩu:
 * nút dẫn tới /api/v1/crm/auth/start → Platform kiểm tra quyền → quay lại CRM bằng mã dùng một lần.
 */
export function Login({ reason }: { reason?: string }) {
  const message = reason ? REASON_VI[reason] || 'Không đăng nhập được. Vui lòng thử lại.' : ''
  const soft = reason === 'LOGGED_OUT' || reason === 'SESSION_EXPIRED' || reason === 'SESSION_REQUIRED'
  return (
    <Shell>
      <h1 className="text-[16px] font-semibold text-[#172B2A] mb-1">Đăng nhập VETCLINIC CRM</h1>
      <p className="text-[12px] text-[#6B7280] mb-5">Dùng tài khoản VETCLINIC của doanh nghiệp. Quyền truy cập do quản trị doanh nghiệp cấp.</p>
      {reason === 'LOGGED_OUT' ? (
        <div role="status" className="flex items-center gap-2 bg-[#F0FDFA] border border-[#99F6E4] rounded-lg px-3 py-2.5 mb-4">
          <Info size={14} className="text-[#0F766E] shrink-0" /><span className="text-[12px] text-[#0F766E]">Bạn đã đăng xuất.</span>
        </div>
      ) : message && (
        <div role={soft ? 'status' : 'alert'} className={`flex items-start gap-2 rounded-lg px-3 py-2.5 mb-4 border ${soft ? 'bg-[#FFFBEB] border-[#FDE68A]' : 'bg-[#FEF2F2] border-[#FECACA]'}`}>
          {soft ? <Info size={14} className="text-[#D97706] shrink-0 mt-0.5" /> : <AlertCircle size={14} className="text-[#DC2626] shrink-0 mt-0.5" />}
          <span className={`text-[12px] ${soft ? 'text-[#B45309]' : 'text-[#DC2626]'}`}>{message}</span>
        </div>
      )}
      <a href={LOGIN_URL} className="w-full h-9 bg-[#0F766E] hover:bg-[#0D5F58] text-white text-[13px] font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
        <LogIn size={14} /> Đăng nhập bằng tài khoản VETCLINIC <ArrowRight size={14} />
      </a>
      <p className="flex items-start gap-1.5 text-[11px] text-[#9CA3AF] mt-4"><ShieldCheck size={12} className="shrink-0 mt-0.5 text-[#0F766E]" />VETCLINIC CRM không lưu mật khẩu của bạn. Đổi mật khẩu tại trang tài khoản VETCLINIC.</p>
    </Shell>
  )
}

/** Doanh nghiệp đã đăng nhập nhưng gói/kết nối không còn hiệu lực. */
export function AccessBlocked({ reason, onLogout }: { reason: string; onLogout: () => void }) {
  return (
    <Shell>
      <div className="flex items-start gap-2 bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2.5 mb-4" role="alert">
        <AlertCircle size={14} className="text-[#DC2626] shrink-0 mt-0.5" />
        <span className="text-[12px] text-[#DC2626]">{REASON_VI[reason] || REASON_VI.ENTITLEMENT_INACTIVE}</span>
      </div>
      <p className="text-[12px] text-[#6B7280] mb-5">Tự động gửi tin của doanh nghiệp đã được dừng an toàn. Vui lòng liên hệ quản trị doanh nghiệp hoặc đội hỗ trợ VETCLINIC CRM để gia hạn hoặc mở lại gói dịch vụ.</p>
      <button onClick={onLogout} className="w-full h-9 border border-[#E2E8F0] text-[#374151] hover:bg-[#F8FAFC] text-[13px] font-medium rounded-lg">Đăng xuất</button>
    </Shell>
  )
}
