import { useState } from 'react'
import { ExternalLink, KeyRound, Monitor, LogOut, ShieldCheck } from 'lucide-react'
import { Badge, Button, Field, Input, PageHeader, cardClass, cx, useToast } from '@/components/ui'
import { api } from '@/lib/api'
import { useCrm } from '@/lib/data'
import { fmtDateTime, initials } from '@/lib/format'

const ROLE_LABEL: Record<string, string> = { CRM_OWNER: 'Chủ doanh nghiệp', CRM_ADMIN: 'Quản trị viên', CRM_STAFF: 'Nhân viên', CRM_VIEWER: 'Người xem' }
const PERMISSION_GROUP: [string, string][] = [
  ['crm.customers', 'Khách hàng'], ['crm.sources', 'Nguồn dữ liệu'], ['crm.zalo', 'Kênh Zalo'], ['crm.templates', 'Mẫu tin nhắn'],
  ['crm.jobs', 'Hàng đợi'], ['crm.optouts', 'Từ chối nhận tin'], ['crm.audit', 'Nhật ký'], ['crm.settings', 'Cài đặt'],
]

function browserLabel(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Microsoft Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Trình duyệt'
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} — ${os}` : browser
}

/** Bản chạy trên PC: đổi mật khẩu tài khoản cục bộ (đăng xuất mọi phiên khác của tài khoản này). */
function LocalPasswordForm() {
  const toast = useToast()
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (form.next !== form.confirm) { toast('error', 'Mật khẩu mới nhập lại không khớp.'); return }
    setBusy(true)
    try { await api.changePassword(form.current, form.next); await api.me(); setForm({ current: '', next: '', confirm: '' }); toast('success', 'Đã đổi mật khẩu. Các phiên khác của tài khoản này đã bị đăng xuất.') }
    catch (err) { toast('error', err instanceof Error ? err.message : 'Không đổi được mật khẩu.') } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Mật khẩu hiện tại" htmlFor="pw-current"><Input id="pw-current" type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required /></Field>
      <Field label="Mật khẩu mới (ít nhất 10 ký tự)" htmlFor="pw-next"><Input id="pw-next" type="password" autoComplete="new-password" minLength={10} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required /></Field>
      <Field label="Nhập lại mật khẩu mới" htmlFor="pw-confirm"><Input id="pw-confirm" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required /></Field>
      <Button type="submit" variant="outline" loading={busy}>Đổi mật khẩu</Button>
    </form>
  )
}

/** Hồ sơ người dùng CRM. Bản VPS: mật khẩu thuộc tài khoản VETCLINIC (Platform). Bản PC: tài khoản cục bộ. */
export default function AdminProfile({ onLogout }: { onLogout: () => Promise<void> }) {
  const { me } = useCrm()
  const [loggingOut, setLoggingOut] = useState(false)
  const name = me.user.displayName || me.user.username || 'Người dùng'
  const role = ROLE_LABEL[me.roles[0]] || 'Người dùng'
  const access = PERMISSION_GROUP.map(([prefix, label]) => {
    const read = me.permissions.some((p) => p === `${prefix}.read`)
    const manage = me.permissions.some((p) => p.startsWith(prefix) && !p.endsWith('.read'))
    return { label, level: manage ? 'Quản lý' : read ? 'Xem' : 'Không' }
  })

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[600px]">
      <PageHeader crumb="Hồ sơ" title="Hồ sơ tài khoản" />

      <div className={cx(cardClass, 'p-5')}>
        <div className="flex items-center gap-4 mb-5">
          <div className="w-14 h-14 rounded-full bg-[#CCFBF1] flex items-center justify-center text-[18px] font-bold text-[#0F766E]">{initials(name)}</div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-[#172B2A] truncate">{name}</div>
            <div className="text-[12px] text-[#6B7280]">{role}{me.tenant.name ? ` · ${me.tenant.name}` : ''}</div>
          </div>
        </div>
        <Field label={me.mode === 'standalone' ? 'Tên đăng nhập' : 'Tên đăng nhập VETCLINIC'} htmlFor="profile-username">
          <Input id="profile-username" value={me.user.username || '—'} readOnly disabled className="text-[13px]" />
        </Field>
        <div className="mt-4">
          <div className="text-[12px] font-medium text-[#374151] mb-2">Quyền trong VETCLINIC CRM</div>
          <div className="flex flex-wrap gap-1.5">
            {access.map((a) => <Badge key={a.label} tone={a.level === 'Quản lý' ? 'brand' : a.level === 'Xem' ? 'gray' : 'red'}>{a.label}: {a.level}</Badge>)}
          </div>
        </div>
      </div>

      <div className={cx(cardClass, 'p-5')}>
        <div className="flex items-center gap-2 text-[14px] font-semibold text-[#172B2A] mb-2"><KeyRound size={15} className="text-[#0F766E]" />Mật khẩu</div>
        {me.mode === 'standalone' ? <LocalPasswordForm /> : <>
        <p className="text-[12px] text-[#6B7280] mb-3">Bạn đăng nhập bằng tài khoản VETCLINIC. Mật khẩu được quản lý tại trang tài khoản VETCLINIC, CRM không lưu mật khẩu của bạn.</p>
        {me.platformAccountUrl
          ? <a href={me.platformAccountUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 h-8 px-3 border border-[#0F766E] text-[#0F766E] hover:bg-[#F0FDFA] text-[12px] font-medium rounded-lg">Đổi mật khẩu tại tài khoản VETCLINIC <ExternalLink size={12} /></a>
          : <p className="text-[11px] text-[#9CA3AF]">Liên kết trang tài khoản VETCLINIC chưa được cấu hình.</p>}
        </>}
      </div>

      <div className={cx(cardClass, 'p-5')}>
        <div className="text-[14px] font-semibold text-[#172B2A] mb-3">Phiên đăng nhập hiện tại</div>
        <div className="flex items-center gap-3 p-3 bg-[#F0FDFA] border border-[#99F6E4] rounded-lg">
          <Monitor size={15} className="text-[#0F766E] shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-medium text-[#172B2A]">{browserLabel()}</div>
            <div className="text-[11px] text-[#6B7280]">Hết hạn lúc {fmtDateTime(me.expiresAt)}</div>
          </div>
          <span className="text-[10px] bg-[#F0FDF4] text-[#16A34A] px-2 py-0.5 rounded-full font-medium">Phiên này</span>
        </div>
        <p className="flex items-start gap-1.5 text-[11px] text-[#9CA3AF] mt-3"><ShieldCheck size={12} className="shrink-0 mt-0.5 text-[#0F766E]" />{me.mode === 'standalone' ? 'Khi chủ doanh nghiệp khóa tài khoản, đổi vai trò hoặc đặt lại mật khẩu, phiên sẽ kết thúc ngay.' : 'Quyền truy cập được kiểm tra lại định kỳ với tài khoản VETCLINIC; khi bị thu hồi, phiên sẽ kết thúc ngay.'}</p>
      </div>

      <p className="text-[11px] text-[#9CA3AF]"><a href="#/giay-phep" className="hover:underline">Giấy phép và ghi công phần mềm</a></p>

      <Button variant="danger" icon={<LogOut size={14} />} loading={loggingOut} onClick={() => { setLoggingOut(true); void onLogout().finally(() => setLoggingOut(false)) }}>Đăng xuất</Button>
    </div>
  )
}
