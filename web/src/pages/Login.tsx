import { useEffect, useState } from 'react'
import { AlertCircle, ArrowRight, Copy, Info, KeyRound, Loader2, LogIn, PawPrint, ShieldCheck } from 'lucide-react'
import { api, ApiError, LOGIN_URL, REASON_VI } from '@/lib/api'
import type { LocalStatus, RevealedCredential } from '@/lib/types'

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
        <p className="text-center text-[11px] text-[#9CA3AF] mt-5">VETCLINIC CRM · Không chia sẻ thông tin đăng nhập · <a href="#/giay-phep" className="hover:underline">Giấy phép</a></p>
      </div>
    </div>
  )
}

function Notice({ reason }: { reason?: string }) {
  if (reason === 'LOGGED_OUT') {
    return (
      <div role="status" className="flex items-center gap-2 bg-[#F0FDFA] border border-[#99F6E4] rounded-lg px-3 py-2.5 mb-4">
        <Info size={14} className="text-[#0F766E] shrink-0" /><span className="text-[12px] text-[#0F766E]">Bạn đã đăng xuất.</span>
      </div>
    )
  }
  const message = reason ? REASON_VI[reason] || reason : ''
  if (!message) return null
  const soft = reason === 'SESSION_EXPIRED' || reason === 'SESSION_REQUIRED'
  return (
    <div role={soft ? 'status' : 'alert'} className={`flex items-start gap-2 rounded-lg px-3 py-2.5 mb-4 border ${soft ? 'bg-[#FFFBEB] border-[#FDE68A]' : 'bg-[#FEF2F2] border-[#FECACA]'}`}>
      {soft ? <Info size={14} className="text-[#D97706] shrink-0 mt-0.5" /> : <AlertCircle size={14} className="text-[#DC2626] shrink-0 mt-0.5" />}
      <span className={`text-[12px] ${soft ? 'text-[#B45309]' : 'text-[#DC2626]'}`}>{message}</span>
    </div>
  )
}

const INPUT = 'w-full h-9 border border-[#E2E8F0] rounded-lg px-3 text-[13px] text-[#172B2A] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20 focus:border-[#0F766E]'
const LABEL = 'block text-[12px] font-medium text-[#374151] mb-1.5'
const PRIMARY = 'w-full h-9 bg-[#0F766E] hover:bg-[#0D5F58] disabled:opacity-60 text-white text-[13px] font-semibold rounded-lg transition-colors flex items-center justify-center gap-2'

/** Bản chạy trên PC: đăng nhập bằng tài khoản do chủ doanh nghiệp tạo trên máy này. */
function LocalLogin({ reason, businessName, onDone }: { reason?: string; businessName: string | null; onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(reason)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined)
    try { await api.localLogin(username, password); onDone() }
    catch (err) { setPassword(''); setError(err instanceof ApiError && err.code ? err.code : 'LOGIN_FAILED') }
    finally { setBusy(false) }
  }
  return (
    <Shell>
      <h1 className="text-[16px] font-semibold text-[#172B2A] mb-1">Đăng nhập VETCLINIC CRM</h1>
      <p className="text-[12px] text-[#6B7280] mb-5">{businessName ? `${businessName} · ` : ''}Tài khoản do chủ doanh nghiệp tạo trên máy này.</p>
      <Notice reason={error} />
      <form onSubmit={submit} className="space-y-3">
        <div><label htmlFor="login-username" className={LABEL}>Tên đăng nhập</label><input id="login-username" autoComplete="username" className={INPUT} value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
        <div><label htmlFor="login-password" className={LABEL}>Mật khẩu</label><input id="login-password" type="password" autoComplete="current-password" className={INPUT} value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
        <button type="submit" disabled={busy} className={PRIMARY}>{busy ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />} Đăng nhập</button>
      </form>
      <p className="flex items-start gap-1.5 text-[11px] text-[#9CA3AF] mt-4"><ShieldCheck size={12} className="shrink-0 mt-0.5 text-[#0F766E]" />Quên mật khẩu: nhờ chủ doanh nghiệp đặt lại trong mục Tài khoản &amp; kết nối.</p>
    </Shell>
  )
}

/** Hiện khóa API vừa tạo đúng một lần. */
export function CredentialReveal({ credential, title, note }: { credential: RevealedCredential; title: string; note: string }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-[15px] font-semibold text-[#172B2A] mb-2"><KeyRound size={16} className="text-[#0F766E]" />{title}</div>
      <p className="text-[12px] text-[#6B7280] mb-3">{note} <b>Mã bí mật chỉ hiện một lần</b> — hãy lưu vào nơi an toàn ngay bây giờ.</p>
      <div className="space-y-2">
        {([['Mã khách (Client ID)', credential.clientId], ['Mã bí mật (Secret)', credential.clientSecret]] as const).map(([label, value]) => (
          <div key={label}>
            <div className={LABEL}>{label}</div>
            <div className="flex gap-2">
              <input readOnly aria-label={label} value={value} className={`${INPUT} font-mono text-[11px]`} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" aria-label={`Sao chép ${label}`} title="Sao chép" onClick={() => void navigator.clipboard?.writeText(value)} className="h-9 w-9 shrink-0 border border-[#E2E8F0] rounded-lg flex items-center justify-center hover:bg-[#F8FAFC] text-[#374151]"><Copy size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Thiết lập lần đầu trên PC: tạo doanh nghiệp + chủ tài khoản; hiện khóa API đúng một lần. */
function LocalSetup({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ businessName: '', displayName: '', username: '', password: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [credential, setCredential] = useState<RevealedCredential | null>(null)
  const [saved, setSaved] = useState(false)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(undefined)
    if (form.password !== form.confirm) { setError('Mật khẩu nhập lại không khớp.'); return }
    setBusy(true)
    try {
      const out = await api.localSetup({ businessName: form.businessName, displayName: form.displayName, username: form.username, password: form.password })
      setForm({ ...form, password: '', confirm: '' })
      setCredential(out.apiCredential)
    } catch (err) { setError(err instanceof Error ? err.message : 'Không thiết lập được.') } finally { setBusy(false) }
  }
  if (credential) {
    return (
      <Shell>
        <CredentialReveal credential={credential} title="Khóa API của doanh nghiệp" note="Dùng để hệ thống phòng khám/bán hàng kết nối với VETCLINIC CRM. Có thể tạo khóa mới sau trong mục Tài khoản & kết nối." />
        <label className="flex items-center gap-2 text-[12px] text-[#374151] my-4"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />Tôi đã lưu mã bí mật</label>
        <button type="button" disabled={!saved} onClick={onDone} className={PRIMARY}>Vào VETCLINIC CRM <ArrowRight size={14} /></button>
      </Shell>
    )
  }
  return (
    <Shell>
      <h1 className="text-[16px] font-semibold text-[#172B2A] mb-1">Thiết lập VETCLINIC CRM trên máy này</h1>
      <p className="text-[12px] text-[#6B7280] mb-5">Chỉ làm một lần. Mỗi máy dùng cho một doanh nghiệp; bạn là chủ tài khoản và có thể thêm nhân viên sau.</p>
      {error && <div role="alert" className="flex items-start gap-2 rounded-lg px-3 py-2.5 mb-4 border bg-[#FEF2F2] border-[#FECACA]"><AlertCircle size={14} className="text-[#DC2626] shrink-0 mt-0.5" /><span className="text-[12px] text-[#DC2626]">{error}</span></div>}
      <form onSubmit={submit} className="space-y-3">
        <div><label htmlFor="setup-business" className={LABEL}>Tên doanh nghiệp / phòng khám</label><input id="setup-business" className={INPUT} value={form.businessName} onChange={set('businessName')} required maxLength={200} /></div>
        <div><label htmlFor="setup-name" className={LABEL}>Tên của bạn</label><input id="setup-name" className={INPUT} value={form.displayName} onChange={set('displayName')} maxLength={200} /></div>
        <div><label htmlFor="setup-username" className={LABEL}>Tên đăng nhập</label><input id="setup-username" autoComplete="username" className={INPUT} value={form.username} onChange={set('username')} required minLength={3} maxLength={80} /></div>
        <div><label htmlFor="setup-password" className={LABEL}>Mật khẩu (ít nhất 10 ký tự)</label><input id="setup-password" type="password" autoComplete="new-password" className={INPUT} value={form.password} onChange={set('password')} required minLength={10} maxLength={200} /></div>
        <div><label htmlFor="setup-confirm" className={LABEL}>Nhập lại mật khẩu</label><input id="setup-confirm" type="password" autoComplete="new-password" className={INPUT} value={form.confirm} onChange={set('confirm')} required /></div>
        <button type="submit" disabled={busy} className={PRIMARY}>{busy && <Loader2 size={14} className="animate-spin" />} Tạo doanh nghiệp</button>
      </form>
    </Shell>
  )
}

/**
 * Bản VPS: đăng nhập qua tài khoản VETCLINIC (Platform), CRM không nhận mật khẩu —
 * nút dẫn tới /api/v1/crm/auth/start → Platform kiểm tra quyền → quay lại CRM bằng mã dùng một lần.
 */
function PlatformLogin({ reason }: { reason?: string }) {
  return (
    <Shell>
      <h1 className="text-[16px] font-semibold text-[#172B2A] mb-1">Đăng nhập VETCLINIC CRM</h1>
      <p className="text-[12px] text-[#6B7280] mb-5">Dùng tài khoản VETCLINIC của doanh nghiệp. Quyền truy cập do quản trị doanh nghiệp cấp.</p>
      <Notice reason={reason} />
      <a href={LOGIN_URL} className="w-full h-9 bg-[#0F766E] hover:bg-[#0D5F58] text-white text-[13px] font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
        <LogIn size={14} /> Đăng nhập bằng tài khoản VETCLINIC <ArrowRight size={14} />
      </a>
      <p className="flex items-start gap-1.5 text-[11px] text-[#9CA3AF] mt-4"><ShieldCheck size={12} className="shrink-0 mt-0.5 text-[#0F766E]" />VETCLINIC CRM không lưu mật khẩu của bạn. Đổi mật khẩu tại trang tài khoản VETCLINIC.</p>
    </Shell>
  )
}

/** Chọn màn đăng nhập theo bản: bản chạy trên PC trả /auth/local/status, bản VPS trả 404. */
export function Login({ reason, onAuthenticated }: { reason?: string; onAuthenticated: () => void }) {
  const [local, setLocal] = useState<LocalStatus | null | undefined>(undefined)
  useEffect(() => { api.localStatus().then(setLocal, () => setLocal(null)) }, [])
  if (local === undefined) return <Shell><div className="flex items-center justify-center gap-2 text-[12px] text-[#6B7280]"><Loader2 size={14} className="animate-spin" /> Đang tải…</div></Shell>
  if (local?.setupRequired) return <LocalSetup onDone={onAuthenticated} />
  if (local) return <LocalLogin reason={reason} businessName={local.businessName} onDone={onAuthenticated} />
  return <PlatformLogin reason={reason} />
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
