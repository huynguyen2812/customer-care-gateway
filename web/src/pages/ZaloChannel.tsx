import { useEffect, useRef, useState } from 'react'
import {
  MessageCircle, Wifi, WifiOff, AlertTriangle, RefreshCw, LogOut, Check, Loader2, QrCode, XCircle, Plus, Pause, Play, Pencil, Star, GitBranch, Trash2,
} from 'lucide-react'
import { Alert, Badge, Button, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Skeleton, Switch, cardClass, cx, useToast } from '@/components/ui'
import { ApiError, api } from '@/lib/api'
import { useCrm } from '@/lib/data'
import { EVENT_LABEL, connectionName, eventLabel, failureLabel, fmtDateTime, fmtNumber, initials, redactMetadata, zaloStatus } from '@/lib/format'
import type { InstallationSummary, ZaloAccount, ZaloRoutingRule } from '@/lib/types'

const REASON_TEXT: Record<string, string> = {
  PAUSED: 'Đang tạm dừng — hệ thống không gửi qua tài khoản này.',
  PENDING_LOGIN: 'Chưa đăng nhập Zalo.',
  CONNECTING: 'Đang chờ quét mã QR.',
  RELOGIN_REQUIRED: 'Phiên Zalo đã hết — cần đăng nhập lại.',
  RATE_LIMITED: 'Zalo đang giới hạn gửi tạm thời.',
  RESTRICTED: 'Tài khoản bị Zalo hạn chế — không dùng để gửi.',
  DISCONNECTED: 'Đã ngắt kết nối.',
  ERROR: 'Tài khoản gặp lỗi.',
  CREDENTIAL_MISSING: 'Chưa đăng ký được với dịch vụ gửi tin.',
  CHANNEL_NOT_ALLOWED: 'Kênh thử nghiệm — không gửi thật.',
  CHANNEL_NOT_SUPPORTED: 'Kênh Zalo OA (ZNS) chưa được hỗ trợ gửi.',
}

type Action = { kind: 'pause' | 'disconnect'; account: ZaloAccount }

export default function ZaloChannel() {
  const crm = useCrm()
  const toast = useToast()
  const list = crm.zalo.data
  const accounts = list?.accounts || []
  const installations = crm.installations.data || []
  const canManage = crm.can('crm.zalo.manage')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ZaloAccount | null>(null)
  const [login, setLogin] = useState<ZaloAccount | null>(null)
  const [assign, setAssign] = useState(false)
  const [action, setAction] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  const totalQuota = accounts.reduce((s, a) => s + a.dailyQuota, 0)
  const sentToday = accounts.reduce((s, a) => s + a.sentToday, 0)
  const usable = accounts.filter((a) => a.usable).length

  const retryRegister = async (a: ZaloAccount) => {
    try { await api.registerZaloSender(a.id); toast('success', `Đã đăng ký ${a.displayName} với dịch vụ gửi tin.`); await crm.reload() }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Không thực hiện được.') }
  }
  const resume = async (a: ZaloAccount) => {
    try { await api.resumeZaloAccount(a.id); toast('success', `Đã bật lại ${a.displayName}.`); await crm.reload() }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Không thực hiện được.') }
  }
  const confirmAction = async () => {
    if (!action) return
    setBusy(true); setActionError('')
    try {
      if (action.kind === 'pause') await api.pauseZaloAccount(action.account.id)
      else await api.disconnectZaloAccount(action.account.id)
      toast('success', action.kind === 'pause' ? `Đã tạm dừng ${action.account.displayName}.` : `Đã ngắt kết nối ${action.account.displayName}.`)
      setAction(null); await crm.reload()
    } catch (e) { setActionError(e instanceof Error ? e.message : 'Không thực hiện được.') } finally { setBusy(false) }
  }

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader crumb="Kênh Zalo" title="Quản lý kênh Zalo" description="Kết nối, phân công và theo dõi các tài khoản Zalo gửi tin nhắc lịch."
        actions={canManage ? <div className="flex gap-2 flex-wrap">
          {accounts.length > 0 && <Button variant="secondary" icon={<GitBranch size={14} />} onClick={() => setAssign(true)}>Phân công</Button>}
          <Button icon={<Plus size={14} />} onClick={() => setAdding(true)}>Thêm tài khoản</Button>
        </div> : undefined} />

      <div className="flex items-start gap-3 bg-[#FFFBEB] border border-[#FDE68A] rounded-[10px] p-4">
        <AlertTriangle size={16} className="text-[#D97706] shrink-0 mt-0.5" />
        <div>
          <div className="text-[12px] font-semibold text-[#92400E]">Lưu ý quan trọng về kênh Zalo cá nhân</div>
          <div className="text-[11px] text-[#B45309] mt-0.5 leading-relaxed">
            Mỗi tài khoản Zalo cá nhân có giới hạn số tin/ngày và có thể bị hạn chế nếu gửi quá nhiều. Chỉ dùng tài khoản tạo riêng cho chăm sóc khách hàng. Hệ thống chỉ nhắn cho khách đã có quan hệ với doanh nghiệp, không kết bạn hay nhắn người lạ, và không tự chuyển sang tài khoản khác khi chưa chắc tin trước đó chưa được gửi.
          </div>
        </div>
      </div>

      {crm.zalo.error ? <div className={cardClass}><ErrorState message={crm.zalo.error} onRetry={() => void crm.reload()} /></div>
        : crm.loading && !list ? <div className={cx(cardClass, 'p-5 space-y-4')}><div className="flex items-center gap-4"><Skeleton className="w-12 h-12 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-24" /></div></div><Skeleton className="h-16 w-full" /></div>
        : accounts.length === 0 ? <div className={cardClass}><EmptyState icon={<MessageCircle size={18} />} title="Chưa có tài khoản Zalo" description="Thêm một tài khoản Zalo dành riêng cho chăm sóc khách hàng để bắt đầu gửi tin nhắc lịch. Có thể thêm nhiều tài khoản và phân công theo chi nhánh." action={canManage ? <Button size="sm" icon={<Plus size={12} />} onClick={() => setAdding(true)}>Thêm tài khoản</Button> : undefined} /></div>
        : <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Tài khoản sẵn sàng gửi" value={`${usable}/${accounts.length}`} warn={usable < accounts.length} />
            <Stat label="Đã gửi hôm nay" value={fmtNumber(sentToday)} />
            <Stat label="Tổng hạn mức các tài khoản" value={`${fmtNumber(totalQuota)} tin/ngày`} />
            <Stat label="Hạn mức doanh nghiệp" value={list?.tenantDailyLimit ? `${fmtNumber(list.tenantDailyLimit)} tin/ngày` : 'Theo từng tài khoản'} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {accounts.map((a) => <AccountCard key={a.id} account={a} installations={installations} canManage={canManage}
              onLogin={() => setLogin(a)} onEdit={() => setEditing(a)} onResume={() => void resume(a)} onRegister={() => void retryRegister(a)}
              onPause={() => { setActionError(''); setAction({ kind: 'pause', account: a }) }} onDisconnect={() => { setActionError(''); setAction({ kind: 'disconnect', account: a }) }} />)}
          </div>
        </>}

      {adding && <AccountForm onClose={() => setAdding(false)} onSaved={async (a) => { setAdding(false); await crm.reload(); toast('success', `Đã thêm ${a.displayName}.`); setLogin(a) }} />}
      {editing && <AccountForm account={editing} onClose={() => setEditing(null)} onSaved={async (a) => { setEditing(null); await crm.reload(); toast('success', `Đã lưu ${a.displayName}.`) }} />}
      {login && <LoginModal account={login} onClose={() => { setLogin(null); void crm.reload() }} />}
      {assign && <AssignmentsModal accounts={accounts} installations={installations} onClose={() => setAssign(false)} onSaved={async () => { setAssign(false); await crm.reload(); toast('success', 'Đã lưu phân công tài khoản Zalo.') }} />}

      <ConfirmDialog open={!!action} tone={action?.kind === 'disconnect' ? 'danger' : 'warning'} icon={action?.kind === 'disconnect' ? <LogOut size={18} /> : <Pause size={18} />}
        title={action?.kind === 'disconnect' ? 'Ngắt kết nối tài khoản Zalo' : 'Tạm dừng tài khoản Zalo'} subtitle={action?.account.displayName}
        confirmLabel={action?.kind === 'disconnect' ? 'Xác nhận ngắt' : 'Tạm dừng'} loading={busy} error={actionError}
        onCancel={() => setAction(null)} onConfirm={() => void confirmAction()}>
        {action?.kind === 'disconnect'
          ? 'Hệ thống ngừng gửi qua tài khoản này ngay. Tin đang chờ sẽ được gửi qua tài khoản khác được phân công (nếu có), hoặc giữ lại tới khi có tài khoản sẵn sàng. Muốn dùng lại phải đăng nhập Zalo lại.'
          : 'Hệ thống ngừng gửi qua tài khoản này cho tới khi bạn bật lại. Tin đang chờ sẽ dùng tài khoản khác được phân công (nếu có).'}
      </ConfirmDialog>
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return <div className={cx(cardClass, 'p-3')}><div className="text-[11px] text-[#6B7280]">{label}</div><div className={cx('text-[15px] font-bold mt-0.5', warn ? 'text-[#B45309]' : 'text-[#172B2A]')}>{value}</div></div>
}

function assignmentText(r: { installationId: string | null; branchId: string | null; eventType: string | null }, installations: InstallationSummary[]): string {
  const parts: string[] = []
  if (r.branchId) parts.push(`Chi nhánh ${r.branchId}`)
  if (r.installationId) { const i = installations.find((x) => x.id === r.installationId); parts.push(i ? connectionName(i) : `Nguồn ${r.installationId.slice(0, 8).toUpperCase()}`) }
  if (!r.branchId && !r.installationId) parts.push('Mọi nguồn')
  if (r.eventType) parts.push(eventLabel(r.eventType))
  return parts.join(' · ')
}

function AccountCard({ account: a, installations, canManage, onLogin, onEdit, onPause, onResume, onDisconnect, onRegister }: {
  account: ZaloAccount; installations: InstallationSummary[]; canManage: boolean
  onLogin: () => void; onEdit: () => void; onPause: () => void; onResume: () => void; onDisconnect: () => void; onRegister: () => void
}) {
  const registrationPending = (a.lastError || '').startsWith('SENDER_REGISTRATION_PENDING')
  const st = zaloStatus(a)
  const pct = a.dailyQuota ? Math.min(100, Math.round((a.sentToday / a.dailyQuota) * 100)) : 0
  const needsLogin = ['PENDING_LOGIN', 'RELOGIN_REQUIRED', 'DISCONNECTED', 'CONNECTING', 'ERROR'].includes(a.status)
  return (
    <div className={cx(cardClass, 'p-5 flex flex-col')}>
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-full bg-[#CCFBF1] flex items-center justify-center text-[13px] font-bold text-[#0F766E] shrink-0">{initials(a.displayName)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[14px] font-semibold text-[#172B2A] truncate max-w-full">{a.displayName}</span>
            <Badge tone={st.tone} icon={a.usable ? <Wifi size={10} /> : <WifiOff size={10} />}>{st.label}</Badge>
            {a.isDefault && <Badge tone="brand" icon={<Star size={10} />}>Mặc định</Badge>}
          </div>
          <div className="text-[12px] text-[#6B7280] mt-0.5">
            {a.channel === 'ZNS' ? 'Zalo OA (ZNS)' : a.channel === 'MOCK' ? 'Kênh thử nghiệm' : 'Zalo cá nhân'}{a.phoneMasked ? ` · ${a.phoneMasked}` : ''} · Ưu tiên {a.priority}
          </div>
        </div>
      </div>

      {!a.usable && a.unavailableReason && <Alert kind={a.unavailableReason === 'RESTRICTED' ? 'error' : 'warning'} className="mt-3">{REASON_TEXT[a.unavailableReason] || failureLabel(a.unavailableReason)}</Alert>}
      {a.lastError && <div className="mt-2 text-[11px] text-[#DC2626]">{registrationPending ? "Chưa đăng ký được với dịch vụ gửi tin — bấm \"Thử đăng ký lại\"." : `Lỗi gần nhất: ${String(redactMetadata(a.lastError))}`}</div>}

      <div className="grid grid-cols-3 gap-2 mt-4">
        <div className="bg-[#F8FAFC] rounded-lg p-2.5"><div className="text-[10px] text-[#6B7280]">Đã gửi hôm nay</div><div className="text-[15px] font-bold text-[#172B2A]">{fmtNumber(a.sentToday)}</div></div>
        <div className="bg-[#F8FAFC] rounded-lg p-2.5"><div className="text-[10px] text-[#6B7280]">Đang chờ gửi</div><div className="text-[15px] font-bold text-[#172B2A]">{fmtNumber(a.queuedJobs)}</div></div>
        <div className="bg-[#F8FAFC] rounded-lg p-2.5"><div className="text-[10px] text-[#6B7280]">Hoạt động gần nhất</div><div className="text-[11px] font-semibold text-[#172B2A] mt-0.5">{fmtDateTime(a.lastActiveAt || a.lastConnectedAt)}</div></div>
      </div>
      <div className="mt-3">
        <div className="flex justify-between text-[11px] text-[#6B7280] mb-1"><span>Hạn mức hôm nay</span><span>{a.sentToday}/{a.dailyQuota} ({pct}%)</span></div>
        <div className="h-1.5 bg-[#F1F5F9] rounded-full overflow-hidden" role="progressbar" aria-label={`Hạn mức ${a.displayName}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={cx('h-full rounded-full', pct >= 90 ? 'bg-[#D97706]' : 'bg-[#0F766E]')} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="mt-3">
        <div className="text-[11px] font-medium text-[#6B7280] mb-1">Phân công gửi</div>
        <div className="flex flex-wrap gap-1.5">
          {a.isDefault && <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#F0FDFA] text-[#0F766E]">Mặc định cho doanh nghiệp</span>}
          {a.assignments.filter((r) => r.active).map((r) => <span key={r.id} className="text-[11px] px-2 py-0.5 rounded-full bg-[#F1F5F9] text-[#374151]">{assignmentText(r, installations)}</span>)}
          {!a.isDefault && !a.assignments.some((r) => r.active) && <span className="text-[11px] text-[#9CA3AF]">Chưa phân công — tài khoản sẽ không được dùng để gửi.</span>}
        </div>
      </div>

      {canManage && <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-[#F1F5F9]">
        {registrationPending && <Button size="sm" icon={<RefreshCw size={12} />} onClick={onRegister}>Thử đăng ký lại</Button>}
        {needsLogin && !registrationPending && <Button size="sm" icon={a.status === 'PENDING_LOGIN' ? <QrCode size={12} /> : <RefreshCw size={12} />} onClick={onLogin}>{a.status === 'PENDING_LOGIN' ? 'Đăng nhập Zalo' : 'Đăng nhập lại'}</Button>}
        {a.paused ? <Button variant="secondary" size="sm" icon={<Play size={12} />} onClick={onResume}>Bật lại</Button>
          : <Button variant="secondary" size="sm" icon={<Pause size={12} />} onClick={onPause}>Tạm dừng</Button>}
        <Button variant="secondary" size="sm" icon={<Pencil size={12} />} onClick={onEdit}>Sửa</Button>
        {a.status !== 'DISCONNECTED' && a.status !== 'PENDING_LOGIN' && <Button variant="danger" size="sm" icon={<LogOut size={12} />} onClick={onDisconnect}>Ngắt kết nối</Button>}
      </div>}
    </div>
  )
}

function AccountForm({ account, onClose, onSaved }: { account?: ZaloAccount; onClose: () => void; onSaved: (a: ZaloAccount) => void | Promise<void> }) {
  const crm = useCrm()
  const [name, setName] = useState(account?.displayName || '')
  const [quota, setQuota] = useState(String(account?.dailyQuota ?? 20))
  const [priority, setPriority] = useState(String(account?.priority ?? 100))
  const [makeDefault, setMakeDefault] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const limit = crm.zalo.data?.tenantDailyLimit ?? null
  const otherQuota = (crm.zalo.data?.accounts || []).filter((a) => a.id !== account?.id).reduce((s, a) => s + a.dailyQuota, 0)
  const save = async () => {
    const q = Number(quota); const p = Number(priority)
    if (name.trim().length < 2) return setError('Tên hiển thị cần ít nhất 2 ký tự.')
    if (!Number.isInteger(q) || q < 1) return setError('Hạn mức phải là số nguyên dương.')
    if (!Number.isInteger(p) || p < 0 || p > 1000) return setError('Mức ưu tiên từ 0 đến 1000 (số nhỏ được ưu tiên trước).')
    setSaving(true); setError('')
    try {
      const out = account
        ? await api.updateZaloAccount(account.id, { ...(name.trim() !== account.displayName ? { displayName: name.trim() } : {}), ...(q !== account.dailyQuota ? { dailyQuota: q } : {}), ...(p !== account.priority ? { priority: p } : {}), ...(makeDefault ? { isDefault: true as const } : {}) })
        : await api.createZaloAccount({ displayName: name.trim(), dailyQuota: q, priority: p, ...(makeDefault ? { isDefault: true } : {}) })
      await onSaved(out)
    } catch (e) { setError(e instanceof ApiError && e.code === 'NO_CHANGE' ? 'Chưa có thay đổi nào.' : e instanceof Error ? e.message : 'Không lưu được.') } finally { setSaving(false) }
  }
  return (
    <Modal open onClose={onClose} title={account ? 'Sửa tài khoản Zalo' : 'Thêm tài khoản Zalo'} width={440}
      footer={<><Button variant="secondary" className="flex-1" onClick={onClose}>Hủy</Button><Button className="flex-1" loading={saving} onClick={() => void save()}>{account ? 'Lưu' : 'Thêm tài khoản'}</Button></>}>
      <div className="p-5 space-y-4">
        <Field label="Tên hiển thị" required htmlFor="za-name" hint="Tên để nhân viên nhận biết, ví dụ “Zalo chi nhánh Quận 1”."><Input id="za-name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hạn mức (tin/ngày)" required htmlFor="za-quota" hint={limit ? `Còn lại cho doanh nghiệp: ${Math.max(0, limit - otherQuota)}` : 'Tối đa 200 khi gói chưa có giới hạn'}><Input id="za-quota" inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} /></Field>
          <Field label="Mức ưu tiên" htmlFor="za-prio" hint="Số nhỏ được ưu tiên trước"><Input id="za-prio" inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} /></Field>
        </div>
        {!account?.isDefault && <Switch checked={makeDefault} onChange={setMakeDefault} label="Đặt làm tài khoản mặc định của doanh nghiệp" />}
        {!account && <p className="text-[11px] text-[#6B7280]">Sau khi thêm, bạn đăng nhập Zalo cho tài khoản bằng mã QR. CRM không bao giờ hỏi mật khẩu Zalo.</p>}
        {error && <Alert kind="error">{error}</Alert>}
      </div>
    </Modal>
  )
}

type LoginState = { phase: 'starting' | 'qr' | 'connected' | 'expired' | 'unsupported' | 'error'; qr?: string; loginId?: string; expiresAt?: string; message?: string }

function LoginModal({ account, onClose }: { account: ZaloAccount; onClose: () => void }) {
  const [s, setS] = useState<LoginState>({ phase: 'starting' })
  const alive = useRef(true)
  const start = async () => {
    setS({ phase: 'starting' })
    try {
      const out = await api.zaloLoginStart(account.id)
      if (alive.current) setS({ phase: 'qr', qr: out.qrImage, loginId: out.loginId, expiresAt: out.expiresAt })
    } catch (e) {
      if (!alive.current) return
      if (e instanceof ApiError && (e.status === 501 || e.code === 'SENDER_NOT_SUPPORTED')) setS({ phase: 'unsupported', message: e.message })
      else setS({ phase: 'error', message: e instanceof Error ? e.message : 'Không tạo được mã QR.' })
    }
  }
  useEffect(() => { alive.current = true; void start(); return () => { alive.current = false } }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (s.phase !== 'qr' || !s.loginId) return
    const t = window.setInterval(async () => {
      try {
        const r = await api.zaloLoginStatus(account.id, s.loginId!)
        if (!alive.current) return
        if (r.status === 'CONNECTED') setS({ phase: 'connected' })
        else if (r.status === 'EXPIRED' || r.status === 'FAILED') setS({ phase: 'expired' })
      } catch { /* thử lại ở lượt sau */ }
    }, 3000)
    return () => window.clearInterval(t)
  }, [s.phase, s.loginId, account.id])

  return (
    <Modal open onClose={onClose} title="Đăng nhập Zalo" subtitle={<span className="text-[12px] text-[#6B7280]">{account.displayName}</span>} width={400}>
      <div className="p-5 space-y-3 text-center">
        {s.phase === 'starting' && <div className="py-8 text-[12px] text-[#6B7280]"><Loader2 size={20} className="animate-spin mx-auto mb-2 text-[#0F766E]" />Đang tạo mã QR…</div>}
        {s.phase === 'qr' && <>
          <p className="text-[12px] text-[#6B7280]">Mở ứng dụng Zalo của tài khoản <strong>{account.displayName}</strong>, vào <strong>Cài đặt → Quét QR</strong>.</p>
          <img src={s.qr} alt="Mã QR đăng nhập Zalo" className="mx-auto w-48 h-48 border border-[#E2E8F0] rounded-xl" />
          <p className="text-[11px] text-[#9CA3AF]">Mã hết hạn lúc {fmtDateTime(s.expiresAt)}. Đang chờ quét…</p>
        </>}
        {s.phase === 'connected' && <div className="py-4 space-y-2"><div className="w-12 h-12 rounded-full bg-[#F0FDF4] flex items-center justify-center mx-auto"><Check size={24} className="text-[#16A34A]" /></div><div className="text-[14px] font-semibold text-[#172B2A]">Đã kết nối</div><p className="text-[12px] text-[#6B7280]">Tài khoản đã sẵn sàng gửi theo phân công.</p></div>}
        {s.phase === 'expired' && <><XCircle size={24} className="mx-auto text-[#D97706]" /><p className="text-[12px] text-[#6B7280]">Mã QR đã hết hạn hoặc đăng nhập không thành công.</p></>}
        {s.phase === 'unsupported' && <Alert kind="warning" title="Chưa thể đăng nhập bằng mã QR">{s.message} Hệ thống không hiển thị mã QR giả.</Alert>}
        {s.phase === 'error' && <Alert kind="error">{s.message}</Alert>}
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" className="flex-1" onClick={onClose}>{s.phase === 'connected' ? 'Hoàn tất' : 'Đóng'}</Button>
          {(s.phase === 'expired' || s.phase === 'error') && <Button className="flex-1" icon={<RefreshCw size={12} />} onClick={() => void start()}>Tạo mã QR mới</Button>}
        </div>
      </div>
    </Modal>
  )
}

type RuleDraft = Omit<ZaloRoutingRule, 'id'> & { key: string }

function AssignmentsModal({ accounts, installations, onClose, onSaved }: { accounts: ZaloAccount[]; installations: InstallationSummary[]; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [rules, setRules] = useState<RuleDraft[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    api.zaloRules().then((r) => setRules(r.map(({ id, ...x }) => ({ ...x, key: id })))).catch((e) => setError(e instanceof Error ? e.message : 'Không tải được phân công.'))
  }, [])
  const update = (key: string, patch: Partial<RuleDraft>) => setRules((rs) => rs!.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const add = () => setRules((rs) => [...(rs || []), { key: `new-${Date.now()}`, zaloAccountId: accounts[0].id, installationId: null, branchId: null, eventType: null, priority: 100, active: true }])
  const save = async () => {
    if (!rules) return
    const bad = rules.find((r) => r.branchId && !/^[A-Za-z0-9._:-]{1,80}$/.test(r.branchId))
    if (bad) return setError('Mã chi nhánh chỉ gồm chữ không dấu, số và các ký tự . _ : -')
    setSaving(true); setError('')
    try { await api.replaceZaloRules(rules.map(({ key: _k, ...r }) => ({ ...r, branchId: r.branchId?.trim() || null }))); await onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Không lưu được.') } finally { setSaving(false) }
  }
  return (
    <Modal open onClose={onClose} title="Phân công tài khoản Zalo" width={760}
      subtitle={<span className="text-[12px] text-[#6B7280]">Thứ tự chọn: theo chi nhánh → theo nguồn dữ liệu → tài khoản mặc định. Tài khoản không có phân công và không phải mặc định sẽ không được dùng.</span>}
      footer={<><Button variant="secondary" className="flex-1" onClick={onClose}>Hủy</Button><Button className="flex-1" loading={saving} disabled={!rules} onClick={() => void save()}>Lưu phân công</Button></>}>
      <div className="p-5 space-y-3">
        {!rules && !error && <Skeleton className="h-24 w-full" />}
        {rules && rules.length === 0 && <p className="text-[12px] text-[#6B7280]">Chưa có phân công. Mọi tin sẽ gửi qua tài khoản mặc định.</p>}
        {rules?.map((r) => (
          <div key={r.key} className="grid grid-cols-2 md:grid-cols-[1.4fr_1.4fr_1fr_1.2fr_70px_auto] gap-2 items-end bg-[#F8FAFC] rounded-lg p-3 [&>*]:min-w-0">
            <Field label="Tài khoản"><Select className="w-full" aria-label="Tài khoản" value={r.zaloAccountId} onChange={(e) => update(r.key, { zaloAccountId: e.target.value })}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}</Select></Field>
            <Field label="Nguồn dữ liệu"><Select className="w-full" aria-label="Nguồn dữ liệu" value={r.installationId || ''} onChange={(e) => update(r.key, { installationId: e.target.value || null })}><option value="">Mọi nguồn</option>{installations.map((i) => <option key={i.id} value={i.id}>{connectionName(i)}</option>)}</Select></Field>
            <Field label="Mã chi nhánh"><Input aria-label="Mã chi nhánh" placeholder="Tất cả" value={r.branchId || ''} onChange={(e) => update(r.key, { branchId: e.target.value || null })} /></Field>
            <Field label="Loại tin"><Select className="w-full" aria-label="Loại tin" value={r.eventType || ''} onChange={(e) => update(r.key, { eventType: e.target.value || null })}><option value="">Mọi loại tin</option>{Object.entries(EVENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Ưu tiên"><Input aria-label="Ưu tiên" inputMode="numeric" value={String(r.priority)} onChange={(e) => update(r.key, { priority: Number(e.target.value) || 0 })} /></Field>
            <div className="flex items-center gap-2 pb-1">
              <Switch checked={r.active} onChange={(v) => update(r.key, { active: v })} label="Bật" />
              <button aria-label="Xóa phân công" onClick={() => setRules((rs) => rs!.filter((x) => x.key !== r.key))} className="w-7 h-7 rounded-lg flex items-center justify-center text-[#DC2626] hover:bg-[#FEF2F2]"><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
        {rules && <Button variant="secondary" size="sm" icon={<Plus size={12} />} onClick={add}>Thêm phân công</Button>}
        {error && <Alert kind="error">{error}</Alert>}
      </div>
    </Modal>
  )
}
