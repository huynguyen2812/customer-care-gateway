import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Link2, OctagonAlert, RefreshCw, UserPlus, Users } from 'lucide-react'
import { Alert, Badge, Button, ErrorState, Field, Input, PageHeader, Select, Skeleton, cardClass, cx, useToast } from '@/components/ui'
import { api } from '@/lib/api'
import { useCrm } from '@/lib/data'
import { fmtDateTime } from '@/lib/format'
import type { LocalCredential, LocalUser, RevealedCredential, SourceConnectorInfo, SourceSyncResult } from '@/lib/types'
import { CredentialReveal } from './Login'

const ROLE_LABEL: Record<string, string> = { CRM_OWNER: 'Chủ doanh nghiệp', CRM_ADMIN: 'Quản trị viên', CRM_STAFF: 'Nhân viên', CRM_VIEWER: 'Người xem' }
const REASON_LABEL: Record<string, string> = {
  STATUS_INELIGIBLE: 'Lịch hẹn đã hủy/xong', BRANCH_NOT_APPROVED: 'Chi nhánh chưa được duyệt', CONTACT_MISSING: 'Thiếu tên/số điện thoại',
  CONSENT_BLOCKED: 'Khách đã từ chối nhận tin', CONSENT_MISSING: 'Không có thông tin đồng ý', PHONE_INVALID: 'Số điện thoại không hợp lệ', REVISION_MISSING: 'Nguồn thiếu mã phiên bản',
}
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Lỗi không xác định')

function Section({ icon, title, description, children }: { icon: React.ReactNode; title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className={cx(cardClass, 'p-5')}>
      <div className="flex items-center gap-2 text-[14px] font-semibold text-[#172B2A]">{icon}{title}</div>
      {description && <p className="text-[12px] text-[#6B7280] mt-1 mb-4">{description}</p>}
      {children}
    </section>
  )
}

function StaffSection() {
  const toast = useToast()
  const [users, setUsers] = useState<LocalUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ username: '', displayName: '', role: 'CRM_STAFF', password: '' })
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => { api.localUsers().then((u) => { setUsers(u); setError(null) }, (e) => setError(errText(e))) }, [])
  useEffect(load, [load])
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true)
    try { await api.createLocalUser(form); setForm({ username: '', displayName: '', role: 'CRM_STAFF', password: '' }); toast('success', 'Đã tạo tài khoản nhân viên.'); load() }
    catch (err) { toast('error', errText(err)) } finally { setBusy(false) }
  }
  const update = async (u: LocalUser, body: Parameters<typeof api.updateLocalUser>[1], done: string) => {
    try { await api.updateLocalUser(u.id, body); toast('success', done); load() } catch (err) { toast('error', errText(err)) }
  }
  const resetPassword = (u: LocalUser) => {
    const pw = window.prompt(`Mật khẩu mới cho ${u.username} (ít nhất 10 ký tự):`)
    if (pw) void update(u, { password: pw }, 'Đã đặt lại mật khẩu; phiên cũ của người này đã bị đăng xuất.')
  }
  return (
    <Section icon={<Users size={15} className="text-[#0F766E]" />} title="Nhân viên" description="Mỗi người một tài khoản riêng. Khóa tài khoản hoặc đổi vai trò sẽ đăng xuất người đó ngay.">
      {error ? <ErrorState message={error} onRetry={load} /> : !users ? <Skeleton className="h-24" /> : (
        <div className="divide-y divide-[#F1F5F9] mb-4">
          {users.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-[#172B2A] truncate">{u.displayName || u.username} <span className="text-[#9CA3AF] font-normal">· {u.username}</span></div>
                <div className="text-[11px] text-[#6B7280]">Đăng nhập gần nhất: {fmtDateTime(u.lastLoginAt)}</div>
              </div>
              <Badge tone={u.role === 'CRM_OWNER' ? 'brand' : 'gray'}>{ROLE_LABEL[u.role] || u.role}</Badge>
              {!u.active && <Badge tone="red">Đã khóa</Badge>}
              {u.locked && <Badge tone="amber">Tạm khóa do sai mật khẩu</Badge>}
              {u.role !== 'CRM_OWNER' && (
                <div className="flex flex-wrap gap-1.5 w-full sm:w-auto">
                  <Select aria-label={`Vai trò của ${u.username}`} value={u.role} onChange={(e) => void update(u, { role: e.target.value }, 'Đã đổi vai trò.')} className="h-8 text-[12px]">
                    {['CRM_ADMIN', 'CRM_STAFF', 'CRM_VIEWER'].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </Select>
                  <Button size="sm" variant="secondary" onClick={() => resetPassword(u)}>Đặt lại mật khẩu</Button>
                  <Button size="sm" variant={u.active ? 'danger' : 'outline'} onClick={() => void update(u, { active: !u.active }, u.active ? 'Đã khóa tài khoản.' : 'Đã mở khóa tài khoản.')}>{u.active ? 'Khóa' : 'Mở khóa'}</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={create} className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-[#F1F5F9] pt-4">
        <Field label="Tên đăng nhập" required htmlFor="staff-username"><Input id="staff-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></Field>
        <Field label="Họ tên" htmlFor="staff-name"><Input id="staff-name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
        <Field label="Vai trò" htmlFor="staff-role"><Select id="staff-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{['CRM_ADMIN', 'CRM_STAFF', 'CRM_VIEWER'].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select></Field>
        <Field label="Mật khẩu ban đầu" required htmlFor="staff-password"><Input id="staff-password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={10} /></Field>
        <div className="sm:col-span-2"><Button type="submit" loading={busy} icon={<UserPlus size={14} />}>Thêm nhân viên</Button></div>
      </form>
    </Section>
  )
}

function CredentialSection({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const [rows, setRows] = useState<LocalCredential[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<RevealedCredential | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => { api.apiCredentials().then((r) => { setRows(r.credentials); setError(null) }, (e) => setError(errText(e))) }, [])
  useEffect(load, [load])
  const rotate = async () => {
    if (!window.confirm('Tạo khóa API mới? Khóa hiện tại còn dùng được thêm 24 giờ để hệ thống bên ngoài kịp đổi.')) return
    setBusy(true)
    try { setRevealed(await api.rotateApiCredential()); load() } catch (err) { toast('error', errText(err)) } finally { setBusy(false) }
  }
  const revoke = async (clientId: string) => {
    if (!window.confirm(`Thu hồi khóa ${clientId}? Hệ thống đang dùng khóa này sẽ mất kết nối ngay.`)) return
    try { await api.revokeApiCredential(clientId); toast('success', 'Đã thu hồi khóa.'); load() } catch (err) { toast('error', errText(err)) }
  }
  return (
    <Section icon={<KeyRound size={15} className="text-[#0F766E]" />} title="Khóa API của doanh nghiệp" description="Hệ thống phòng khám/bán hàng dùng khóa này để kết nối với VETCLINIC CRM (ký HMAC). Mã bí mật chỉ hiện một lần khi tạo.">
      {revealed && (
        <div className="mb-4 p-4 rounded-lg border border-[#99F6E4] bg-[#F0FDFA]">
          <CredentialReveal credential={revealed} title="Khóa mới" note="Cập nhật khóa này vào hệ thống bên ngoài." />
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => setRevealed(null)}>Tôi đã lưu, ẩn đi</Button>
        </div>
      )}
      {error ? <ErrorState message={error} onRetry={load} /> : !rows ? <Skeleton className="h-16" /> : (
        <div className="divide-y divide-[#F1F5F9] mb-3">
          {rows.map((c) => (
            <div key={c.clientId} className="flex flex-wrap items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-mono text-[#172B2A] truncate">{c.clientId} · …{c.secretLast4}</div>
                <div className="text-[11px] text-[#6B7280]">Tạo lúc {fmtDateTime(c.createdAt)}{c.expiresAt ? ` · hết hạn ${fmtDateTime(c.expiresAt)}` : ''}</div>
              </div>
              <Badge tone={c.usable ? (c.status === 'ACTIVE' ? 'green' : 'amber') : 'red'}>{!c.usable ? 'Không còn hiệu lực' : c.status === 'ACTIVE' ? 'Đang dùng' : 'Đang chuyển khóa'}</Badge>
              {canManage && c.usable && <Button size="sm" variant="danger" onClick={() => void revoke(c.clientId)}>Thu hồi</Button>}
            </div>
          ))}
        </div>
      )}
      {canManage && <Button variant="outline" loading={busy} icon={<RefreshCw size={14} />} onClick={() => void rotate()}>Tạo khóa mới</Button>}
    </Section>
  )
}

function ConnectorSection({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const [info, setInfo] = useState<SourceConnectorInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ sourceKind: '', apiBaseUrl: '', branches: '', lead: 1440, appointments: true, receivables: false, active: false })
  const [busy, setBusy] = useState<'' | 'save' | 'preview' | 'sync'>('')
  const [result, setResult] = useState<SourceSyncResult | null>(null)
  const load = useCallback(() => {
    api.sourceConnector().then((i) => {
      setInfo(i); setError(null)
      if (i.connection) setForm({ sourceKind: i.connection.sourceKind || '', apiBaseUrl: i.connection.apiBaseUrl, branches: i.connection.allowedBranchIds.join(', '), lead: i.connection.reminderLeadMinutes, appointments: i.connection.appointmentsEnabled, receivables: i.connection.receivablesEnabled, active: i.connection.active })
    }, (e) => setError(errText(e)))
  }, [])
  useEffect(load, [load])
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy('save')
    try {
      setInfo(await api.saveSourceConnector({ sourceKind: form.sourceKind, apiBaseUrl: form.apiBaseUrl.trim(), allowedBranchIds: form.branches.split(',').map((b) => b.trim()).filter(Boolean), reminderLeadMinutes: Number(form.lead), appointmentsEnabled: form.appointments, receivablesEnabled: form.receivables, active: form.active }))
      toast('success', 'Đã lưu kết nối nguồn.')
    } catch (err) { toast('error', errText(err)) } finally { setBusy('') }
  }
  const run = async (kind: 'preview' | 'sync') => {
    if (kind === 'sync' && !window.confirm('Tạo lịch nhắc cho các lịch hẹn hợp lệ? Tin chỉ được gửi sau khi kiểm tra lại với hệ thống nguồn ngay trước giờ gửi.')) return
    setBusy(kind)
    try { setResult(kind === 'preview' ? await api.previewAppointments() : await api.syncAppointments()); load() } catch (err) { toast('error', errText(err)) } finally { setBusy('') }
  }
  const c = info?.connection
  return (
    <Section icon={<Link2 size={15} className="text-[#0F766E]" />} title="Kết nối nguồn dữ liệu" description="CRM đọc lịch hẹn/công nợ từ hệ thống của doanh nghiệp theo chuẩn VETCLINIC Source Connector v1 và kiểm tra lại ngay trước khi gửi. Nguồn không phản hồi thì không gửi.">
      {error ? <ErrorState message={error} onRetry={load} /> : !info ? <Skeleton className="h-24" /> : (
        <>
          {c && <div className="flex flex-wrap gap-2 mb-4 text-[12px]"><Badge tone={c.active ? 'green' : 'gray'}>{c.active ? 'Đang bật' : 'Đang tắt'}</Badge><span className="text-[#6B7280]">Đồng bộ gần nhất: {fmtDateTime(c.lastSyncAt)} {c.lastSyncStatus ? `(${c.lastSyncStatus})` : ''}</span>{c.lastError && <Badge tone="red">{c.lastError}</Badge>}</div>}
          <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2"><Field label="Loại hệ thống nguồn" required hint="Platform cấp chi nhánh riêng cho từng loại nguồn; CRM chỉ kiểm tra theo đúng loại được chọn ở đây." htmlFor="src-kind"><Select id="src-kind" value={form.sourceKind} onChange={(e) => setForm({ ...form, sourceKind: e.target.value })} disabled={!canManage} required><option value="" disabled>— Chọn loại hệ thống —</option><option value="PETCLINIC">PETCLINIC (phòng khám thú y)</option><option value="B2B_SALE">B2B SALE (bán hàng, công nợ)</option><option value="EXTERNAL">Hệ thống khác</option></Select></Field></div>
            <div className="sm:col-span-2"><Field label="Địa chỉ API của hệ thống nguồn" required hint="HTTPS, hoặc http://127.0.0.1 nếu hệ thống chạy trên chính máy này." htmlFor="src-url"><Input id="src-url" value={form.apiBaseUrl} onChange={(e) => setForm({ ...form, apiBaseUrl: e.target.value })} disabled={!canManage} placeholder="https://phongkham.local/connector/v1" required /></Field></div>
            <Field label="Chi nhánh được duyệt (cách nhau dấu phẩy)" required htmlFor="src-branches"><Input id="src-branches" value={form.branches} onChange={(e) => setForm({ ...form, branches: e.target.value })} disabled={!canManage} required /></Field>
            <Field label="Nhắc trước lịch hẹn (phút)" htmlFor="src-lead"><Input id="src-lead" type="number" min={15} max={10080} value={form.lead} onChange={(e) => setForm({ ...form, lead: Number(e.target.value) })} disabled={!canManage} /></Field>
            <div className="sm:col-span-2 flex flex-wrap gap-4 text-[12px] text-[#374151]">
              <label className="flex items-center gap-2"><input type="checkbox" checked={form.appointments} disabled={!canManage} onChange={(e) => setForm({ ...form, appointments: e.target.checked })} />Nhắc lịch hẹn</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={form.receivables} disabled={!canManage} onChange={(e) => setForm({ ...form, receivables: e.target.checked })} />Nhắc công nợ (chỉ khách đã đồng ý rõ ràng)</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={form.active} disabled={!canManage} onChange={(e) => setForm({ ...form, active: e.target.checked })} />Bật kết nối</label>
            </div>
            {canManage && <div className="sm:col-span-2"><Button type="submit" loading={busy === 'save'}>Lưu kết nối</Button></div>}
          </form>
          {c?.active && c.appointmentsEnabled && (
            <div className="border-t border-[#F1F5F9] mt-4 pt-4">
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" loading={busy === 'preview'} onClick={() => void run('preview')}>Xem trước 7 ngày tới (không gửi)</Button>
                {canManage && <Button variant="outline" loading={busy === 'sync'} onClick={() => void run('sync')}>Tạo lịch nhắc</Button>}
              </div>
              {result && (
                <div className="mt-3 text-[12px] text-[#374151]">
                  <div>{result.dryRun ? 'Xem trước' : 'Đã tạo'}: {result.scanned} lịch hẹn, {result.eligible} đủ điều kiện{result.dryRun ? '' : `, ${result.created} lịch nhắc mới, ${result.cancelled} lịch nhắc cũ đã hủy`}.</div>
                  {Object.entries(result.skippedByReason).map(([k, v]) => <div key={k} className="text-[#6B7280]">· {REASON_LABEL[k] || k}: {v}</div>)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Section>
  )
}

function EmergencyStopSection({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const [state, setState] = useState<{ enabled: boolean; changedAt: string | null } | null>(null)
  const load = useCallback(() => { api.emergencyStop().then(setState, () => setState(null)) }, [])
  useEffect(load, [load])
  const toggle = async () => {
    const next = !state?.enabled
    if (!window.confirm(next ? 'DỪNG KHẨN CẤP mọi tin nhắn tự động trên máy này?' : 'Cho phép gửi tin tự động trở lại?')) return
    try { await api.setEmergencyStop(next, next ? 'Dừng khẩn cấp từ CRM' : 'Mở lại từ CRM'); toast('success', next ? 'Đã dừng khẩn cấp.' : 'Đã cho phép gửi lại.'); load() } catch (err) { toast('error', errText(err)) }
  }
  return (
    <Section icon={<OctagonAlert size={15} className="text-[#DC2626]" />} title="Dừng khẩn cấp" description="Giữ nguyên hàng đợi nhưng không gửi bất kỳ tin nào cho tới khi mở lại. Tin nào trễ quá 12 giờ sẽ tự bỏ, không gửi dồn.">
      {state?.enabled && <Alert kind="error" className="mb-3">Đang DỪNG KHẨN CẤP từ {fmtDateTime(state.changedAt)}.</Alert>}
      {canManage && <Button variant={state?.enabled ? 'outline' : 'danger'} onClick={() => void toggle()}>{state?.enabled ? 'Cho phép gửi lại' : 'Dừng khẩn cấp'}</Button>}
    </Section>
  )
}

/** Chỉ có ở bản chạy trên PC: nhân viên, khóa API tự sinh, kết nối nguồn, dừng khẩn cấp. */
export default function StandaloneSettings() {
  const { can } = useCrm()
  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[860px]">
      <PageHeader crumb="Tài khoản & kết nối" title="Tài khoản & kết nối" description="Bản VETCLINIC CRM chạy trên máy này: tài khoản, khóa API và nguồn dữ liệu đều nằm trên máy, không qua máy chủ VETCLINIC." />
      {can('crm.users.manage') && <StaffSection />}
      <CredentialSection canManage={can('crm.sources.manage')} />
      <ConnectorSection canManage={can('crm.sources.manage')} />
      <EmergencyStopSection canManage={can('crm.settings.manage')} />
    </div>
  )
}
