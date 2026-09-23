import { useMemo, useState, type FormEvent } from 'react'
import { Plus, CheckCircle2, AlertCircle, XCircle, PauseCircle, Eye, EyeOff, RefreshCw, Database, Plug, ChevronDown, ChevronRight, Info } from 'lucide-react'
import { Alert, Button, EmptyState, ErrorState, Field, Input, Modal, Skeleton, Textarea, cardClass, cx, useToast } from '@/components/ui'
import { api } from '@/lib/api'
import { useCrm } from '@/lib/data'
import { SOURCE_FAMILIES, connectionName, fmtDateTime, redactMetadata, sourceFamily } from '@/lib/format'
import type { InstallationSummary, PetclinicPreview } from '@/lib/types'

type ConnStatus = 'connected' | 'unconfigured' | 'disconnected' | 'paused' | 'revoked'

function connStatus(i: InstallationSummary): ConnStatus {
  if (i.status === 'REVOKED') return 'revoked'
  if (i.paused || i.status === 'SUSPENDED') return 'paused'
  if (i.status === 'ERROR' || i.petclinicConnection?.lastSyncStatus === 'FAILED') return 'disconnected'
  if (sourceFamily(i.sourceProduct).key === 'PETCLINIC') return i.petclinicConnection?.active ? 'connected' : 'unconfigured'
  return i.status === 'ACTIVE' ? 'connected' : 'unconfigured'
}

const STATUS: Record<ConnStatus, { label: string; Icon: typeof CheckCircle2; cls: string }> = {
  connected: { label: 'Đã kết nối', Icon: CheckCircle2, cls: 'text-[#16A34A] bg-[#F0FDF4]' },
  unconfigured: { label: 'Chưa cấu hình', Icon: AlertCircle, cls: 'text-[#6B7280] bg-[#F9FAFB]' },
  disconnected: { label: 'Mất kết nối', Icon: XCircle, cls: 'text-[#DC2626] bg-[#FEF2F2]' },
  paused: { label: 'Đã tạm dừng', Icon: PauseCircle, cls: 'text-[#D97706] bg-[#FFFBEB]' },
  revoked: { label: 'Đã thu hồi', Icon: XCircle, cls: 'text-[#6B7280] bg-[#F1F5F9]' },
}
function StatusBadge({ status }: { status: ConnStatus }) {
  const s = STATUS[status]
  return <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full whitespace-nowrap ${s.cls}`}><s.Icon size={11} /> {s.label}</span>
}
function TypeBadge({ label, tone }: { label: string; tone: 'brand' | 'blue' | 'gray' }) {
  return <span className={cx('text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap', tone === 'brand' ? 'bg-[#F0FDFA] text-[#0F766E]' : tone === 'blue' ? 'bg-[#EFF6FF] text-[#1D4ED8]' : 'bg-[#F1F5F9] text-[#374151]')}>{label}</span>
}

const SKIP_REASON: Record<string, string> = {
  STATUS_INELIGIBLE: 'Lịch hẹn không còn hiệu lực', BRANCH_NOT_APPROVED: 'Chi nhánh chưa được duyệt', CONTACT_MISSING: 'Thiếu tên hoặc số điện thoại',
  CONSENT_MISSING: 'Chưa đồng ý nhận tin', NOT_IN_PILOT_ALLOWLIST: 'Số chưa nằm trong danh sách thử nghiệm', PHONE_INVALID: 'Số điện thoại không hợp lệ',
}

export default function DataSources() {
  const crm = useCrm()
  const toast = useToast()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [configFor, setConfigFor] = useState<InstallationSummary | null>(null)
  const [picker, setPicker] = useState(false)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, PetclinicPreview>>({})

  const rows = crm.installations.data || []
  const groups = useMemo(() => {
    const known = SOURCE_FAMILIES.map((f) => ({ family: f, items: rows.filter((r) => f.products.includes(r.sourceProduct)) }))
    const other = rows.filter((r) => !SOURCE_FAMILIES.some((f) => f.products.includes(r.sourceProduct)))
    return other.length ? [...known, { family: { key: 'OTHER', label: 'Khác', title: 'Nguồn dữ liệu khác', products: [], tone: 'gray' as const, configurable: false }, items: other }] : known
  }, [rows])
  const statuses = rows.map(connStatus)

  const runPreview = async (i: InstallationSummary) => {
    setPreviewing(i.id)
    try {
      const out = await api.previewPetclinic(i.id)
      setPreviews((p) => ({ ...p, [i.id]: out }))
      toast('success', 'Kết nối hoạt động — đã xem trước dữ liệu (không gửi tin).')
      void crm.reload()
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Không kiểm tra được kết nối.') } finally { setPreviewing(null) }
  }

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-[11px] text-[#6B7280] mb-1">VETCLINIC CRM / Nguồn dữ liệu</div>
          <h1 className="text-[20px] font-bold text-[#172B2A]">Nguồn dữ liệu</h1>
          <p className="text-[13px] text-[#6B7280] mt-0.5">Quản lý các kết nối dữ liệu khách hàng từ PETCLINIC và B2B SALE.</p>
        </div>
        {crm.can('crm.sources.manage') && <Button icon={<Plus size={14} />} onClick={() => setPicker(true)}>Thêm kết nối dữ liệu</Button>}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Tổng kết nối', value: rows.length },
          { label: 'Đang hoạt động', value: statuses.filter((s) => s === 'connected').length },
          { label: 'Cần kiểm tra', value: statuses.filter((s) => s !== 'connected').length },
        ].map((s) => (
          <div key={s.label} className="bg-white border border-[#E2E8F0] rounded-lg p-3 text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
            {crm.loading && !crm.installations.data ? <Skeleton className="h-6 w-8 mx-auto mb-1" /> : <div className="text-[20px] font-bold text-[#172B2A]">{s.value}</div>}
            <div className="text-[11px] text-[#6B7280]">{s.label}</div>
          </div>
        ))}
      </div>

      {crm.installations.error ? <div className={cardClass}><ErrorState message={crm.installations.error} onRetry={() => void crm.reload()} /></div>
        : crm.loading && !crm.installations.data ? <div className={cx(cardClass, 'p-5 space-y-3')}>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        : groups.map(({ family, items }) => {
          const open = !collapsed.has(family.key)
          return (
            <div key={family.key} className={cx(cardClass, 'overflow-hidden')}>
              <button onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(family.key)) n.delete(family.key); else n.add(family.key); return n })} aria-expanded={open}
                className="w-full flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-[#F8FAFC] transition-colors text-left">
                <div className="flex items-center gap-3 flex-wrap min-w-0">
                  <TypeBadge label={family.label} tone={family.tone} />
                  <span className="text-[13px] font-semibold text-[#172B2A]">{family.title}</span>
                  <span className="text-[11px] text-[#9CA3AF]">{items.length} kết nối dữ liệu</span>
                </div>
                {open ? <ChevronDown size={15} className="text-[#9CA3AF] shrink-0" /> : <ChevronRight size={15} className="text-[#9CA3AF] shrink-0" />}
              </button>
              {open && (
                <div className="border-t border-[#F1F5F9]">
                  {items.length === 0 && <div className="px-5 py-4 text-[12px] text-[#9CA3AF]">Chưa có kết nối dữ liệu {family.label}.</div>}
                  {items.map((s) => {
                    const st = connStatus(s)
                    const pc = s.petclinicConnection
                    const preview = previews[s.id]
                    return (
                      <div key={s.id} className="border-b border-[#F8FAFC] last:border-0">
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-4 px-5 py-3.5 hover:bg-[#F8FAFC] transition-colors">
                          <div className="flex items-center gap-3 md:flex-1 min-w-0">
                            <div className="w-8 h-8 rounded-lg bg-[#F0FDFA] flex items-center justify-center shrink-0"><Database size={14} className="text-[#0F766E]" /></div>
                            <div className="min-w-0">
                              <div className="text-[13px] font-medium text-[#172B2A] truncate">{connectionName(s)}</div>
                              <div className="text-[11px] text-[#9CA3AF] truncate">{pc ? `Mã phòng khám nguồn: ${pc.apiTenantId}` : family.configurable ? 'Chưa cấu hình kết nối nguồn' : 'Nguồn tự gửi lịch nhắc qua kết nối bảo mật'}</div>
                            </div>
                          </div>
                          <div className="md:flex-1 min-w-0">
                            <div className="flex gap-1 flex-wrap">
                              {pc?.allowedBranchIds.length ? pc.allowedBranchIds.map((b) => <span key={b} className="text-[10px] bg-[#F1F5F9] text-[#374151] px-2 py-0.5 rounded">CN {b}</span>) : <span className="text-[11px] text-[#9CA3AF]">Chưa có chi nhánh</span>}
                            </div>
                          </div>
                          <div className="md:text-right shrink-0">
                            <StatusBadge status={st} />
                            <div className="text-[10px] text-[#9CA3AF] mt-0.5">{family.configurable ? `Đồng bộ: ${fmtDateTime(pc?.lastSyncAt)}` : `Kết nối cuối: ${fmtDateTime(s.lastConnectedAt)}`}</div>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            {family.configurable && st !== 'revoked' && crm.can('crm.sources.manage') && <button onClick={() => setConfigFor(s)} className="text-[11px] text-[#0F766E] hover:underline">Cấu hình</button>}
                            {pc?.active && st !== 'revoked' && crm.can('crm.sources.manage') && (
                              <button onClick={() => void runPreview(s)} disabled={previewing === s.id} className="flex items-center gap-1 text-[11px] text-[#6B7280] hover:text-[#374151] disabled:opacity-60">
                                <RefreshCw size={10} className={previewing === s.id ? 'animate-spin' : ''} /> Xem trước
                              </button>
                            )}
                          </div>
                        </div>
                        {(pc?.lastError || s.lastError) && <div className="px-5 pb-3"><Alert kind="error">Lỗi gần nhất: {String(redactMetadata(pc?.lastError || s.lastError))}</Alert></div>}
                        {preview && <div className="px-5 pb-4"><PreviewResult preview={preview} /></div>}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

      {!crm.loading && rows.length === 0 && !crm.installations.error && (
        <div className={cardClass}><EmptyState icon={<Database size={18} />} title="Chưa có kết nối dữ liệu" description="Kết nối dữ liệu được đội hỗ trợ VETCLINIC CRM cấp cho doanh nghiệp theo gói dịch vụ. Sau khi được cấp, bạn có thể cấu hình tại đây." /></div>
      )}

      <div className="bg-[#F8FAFC] border border-dashed border-[#CBD5E1] rounded-[10px] p-4 text-center">
        <div className="text-[12px] text-[#9CA3AF]">Các nguồn dữ liệu khác sẽ được bổ sung trong thời gian tới.</div>
      </div>

      <SourcePicker open={picker} onClose={() => setPicker(false)} installations={rows} onPick={(i) => { setPicker(false); setConfigFor(i) }} />
      {configFor && <PetclinicConfigModal installation={configFor} onClose={() => setConfigFor(null)} onSaved={() => { setConfigFor(null); void crm.reload() }} onPreview={runPreview} />}
    </div>
  )
}

function PreviewResult({ preview }: { preview: PetclinicPreview }) {
  const skipped = preview.scanned - preview.eligible
  const reasons = Object.entries(preview.skippedByReason || {}).map(([k, v]) => `${SKIP_REASON[k] || k} (${v})`).join(', ')
  return (
    <div className="bg-[#F8FAFC] rounded-lg p-3 space-y-1.5 text-[12px]">
      {[['Tổng lịch hẹn', preview.scanned], ['Đủ điều kiện gửi', preview.eligible], ['Bị bỏ qua', skipped], ['Lý do bỏ qua', reasons || '—']].map(([k, v]) => (
        <div key={String(k)} className="flex justify-between gap-3"><span className="text-[#6B7280]">{k}</span><span className="font-medium text-[#172B2A] text-right">{v}</span></div>
      ))}
      <p className="text-[11px] text-[#9CA3AF] pt-1 border-t border-[#E2E8F0]">* Xem trước không gửi tin thật và không tạo tác vụ chăm sóc.</p>
    </div>
  )
}

function SourcePicker({ open, onClose, installations, onPick }: { open: boolean; onClose: () => void; installations: InstallationSummary[]; onPick: (i: InstallationSummary) => void }) {
  const [family, setFamily] = useState(SOURCE_FAMILIES[0].key)
  const f = SOURCE_FAMILIES.find((x) => x.key === family)!
  const available = installations.filter((i) => f.products.includes(i.sourceProduct) && i.status !== 'REVOKED')
  return (
    <Modal open={open} onClose={onClose} title="Thêm kết nối dữ liệu" footer={<Button variant="secondary" className="flex-1 text-[12px]" onClick={onClose}>Đóng</Button>}>
      <div className="px-6 py-4 space-y-4">
        <div>
          <div className="text-[12px] font-medium text-[#374151] mb-2">Loại nguồn dữ liệu</div>
          <div className="flex gap-2">
            {SOURCE_FAMILIES.map((t) => (
              <button key={t.key} onClick={() => setFamily(t.key)} aria-pressed={family === t.key}
                className={cx('flex-1 h-9 rounded-lg border text-[12px] font-medium transition-colors', family === t.key ? 'bg-[#F0FDFA] border-[#0F766E] text-[#0F766E]' : 'border-[#E2E8F0] text-[#6B7280] hover:bg-[#F8FAFC]')}>{t.label}</button>
            ))}
          </div>
        </div>
        {!f.configurable ? (
          <Alert kind="info" title={`${f.label} chưa hỗ trợ cấu hình trên CRM`}>Kết nối {f.label} được đội hỗ trợ VETCLINIC CRM thiết lập trực tiếp. Tính năng tự cấu hình sẽ được bổ sung sau.</Alert>
        ) : available.length === 0 ? (
          <Alert kind="info" title="Doanh nghiệp chưa được cấp kết nối PETCLINIC">Liên hệ đội hỗ trợ VETCLINIC CRM để được cấp kết nối dữ liệu theo gói dịch vụ. Sau khi được cấp, kết nối sẽ xuất hiện tại đây để bạn cấu hình.</Alert>
        ) : (
          <div className="space-y-2">
            <div className="text-[12px] text-[#6B7280]">Chọn kết nối dữ liệu đã được cấp để cấu hình:</div>
            {available.map((i) => (
              <button key={i.id} onClick={() => onPick(i)} className="w-full flex items-center justify-between gap-3 border border-[#E2E8F0] rounded-lg px-3 py-2.5 hover:border-[#0F766E] hover:bg-[#F0FDFA] text-left">
                <span className="text-[12px] font-medium text-[#172B2A]">{connectionName(i)}</span>
                <StatusBadge status={connStatus(i)} />
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

const LEAD_OPTIONS = [{ v: 1440, l: '24 giờ trước' }, { v: 720, l: '12 giờ trước' }, { v: 120, l: '2 giờ trước' }]

function PetclinicConfigModal({ installation, onClose, onSaved, onPreview }: { installation: InstallationSummary; onClose: () => void; onSaved: () => void; onPreview: (i: InstallationSummary) => Promise<void> }) {
  const pc = installation.petclinicConnection
  const toast = useToast()
  const [form, setForm] = useState({
    apiBaseUrl: pc?.apiBaseUrl || '', apiToken: '', apiTenantId: pc?.apiTenantId || '',
    branches: (pc?.allowedBranchIds || []).join(', '), lead: pc?.reminderLeadMinutes || 1440, phones: '', active: pc?.active ?? false,
  })
  const [showToken, setShowToken] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState('')
  const [testing, setTesting] = useState(false)
  const set = (k: keyof typeof form, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }))

  const validate = () => {
    const e: Record<string, string> = {}
    try { const u = new URL(form.apiBaseUrl); if (!['https:', 'http:'].includes(u.protocol)) throw new Error() } catch { e.apiBaseUrl = 'Nhập địa chỉ API hợp lệ, ví dụ https://api.petclinic.vn' }
    if (form.apiToken.length < 16) e.apiToken = pc ? 'Nhập lại mã truy cập (tối thiểu 16 ký tự) để lưu thay đổi.' : 'Mã truy cập tối thiểu 16 ký tự.'
    if (!form.apiTenantId.trim()) e.apiTenantId = 'Bắt buộc nhập mã phòng khám trên PETCLINIC.'
    if (!form.branches.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).length) e.branches = 'Cần ít nhất một chi nhánh được duyệt.'
    setErrors(e)
    return !Object.keys(e).length
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    setServerError('')
    if (!validate()) return
    setSaving(true)
    try {
      await api.configurePetclinic(installation.id, {
        apiBaseUrl: form.apiBaseUrl.trim(), apiToken: form.apiToken, apiTenantId: form.apiTenantId.trim(),
        allowedBranchIds: form.branches.split(/[,\n]/).map((x) => x.trim()).filter(Boolean),
        pilotAllowedPhones: form.phones.split(/[,\n]/).map((x) => x.trim()).filter(Boolean),
        reminderLeadMinutes: Number(form.lead), active: form.active,
      })
      setForm((f) => ({ ...f, apiToken: '', phones: '' }))
      toast('success', 'Đã lưu cấu hình kết nối PETCLINIC.')
      onSaved()
    } catch (e) { setServerError(e instanceof Error ? e.message : 'Không lưu được cấu hình.') } finally { setSaving(false) }
  }

  const test = async () => { setTesting(true); try { await onPreview(installation) } finally { setTesting(false) } }

  return (
    <Modal open onClose={onClose} width={520}
      title="Cấu hình kết nối dữ liệu"
      subtitle={<div className="flex items-center gap-2"><TypeBadge label="PETCLINIC" tone="brand" /><span className="text-[11px] text-[#6B7280]">{connectionName(installation)}</span></div>}
      footer={<>
        <Button type="button" variant="secondary" className="flex-1 text-[12px]" onClick={onClose} disabled={saving}>Hủy</Button>
        <Button type="submit" form="petclinic-config" className="flex-1 text-[12px]" loading={saving}>{saving ? 'Đang lưu…' : 'Lưu kết nối'}</Button>
      </>}
    >
      <form id="petclinic-config" onSubmit={submit} noValidate className="px-6 py-5 space-y-4">
        {serverError && <Alert kind="error">{serverError}</Alert>}
        <Field label="API URL" required htmlFor="pc-url" error={errors.apiBaseUrl}>
          <Input id="pc-url" value={form.apiBaseUrl} onChange={(e) => set('apiBaseUrl', e.target.value)} placeholder="https://api.petclinic.vn" invalid={!!errors.apiBaseUrl} />
        </Field>
        <Field label="Mã truy cập API" required htmlFor="pc-token" error={errors.apiToken} hint={pc ? 'Mã đang dùng được lưu mã hóa và không bao giờ hiển thị lại. Nhập mã để cập nhật.' : 'Mã được lưu mã hóa, không hiển thị lại sau khi lưu.'}>
          <div className="relative">
            <Input id="pc-token" type={showToken ? 'text' : 'password'} autoComplete="off" value={form.apiToken} onChange={(e) => set('apiToken', e.target.value)} placeholder={pc ? '•••••••• (đã lưu)' : ''} className="pr-9 font-mono" invalid={!!errors.apiToken} />
            <button type="button" aria-label={showToken ? 'Ẩn mã' : 'Hiện mã vừa nhập'} onClick={() => setShowToken((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#9CA3AF] hover:text-[#6B7280]">{showToken ? <EyeOff size={14} /> : <Eye size={14} />}</button>
          </div>
        </Field>
        <Field label="Mã phòng khám trên PETCLINIC" required htmlFor="pc-tenant" error={errors.apiTenantId}>
          <Input id="pc-tenant" value={form.apiTenantId} onChange={(e) => set('apiTenantId', e.target.value)} invalid={!!errors.apiTenantId} />
        </Field>
        <Field label="Chi nhánh được phép gửi" required htmlFor="pc-branches" error={errors.branches} hint="Nhập mã chi nhánh, cách nhau bởi dấu phẩy.">
          <Input id="pc-branches" value={form.branches} onChange={(e) => set('branches', e.target.value)} placeholder="1, 2" invalid={!!errors.branches} />
        </Field>
        <Field label="Khoảng thời gian nhắc lịch" htmlFor="pc-lead">
          <select id="pc-lead" value={form.lead} onChange={(e) => set('lead', Number(e.target.value))} className="w-full h-9 px-3 border border-[#E2E8F0] rounded-lg text-[12px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20 focus:border-[#0F766E]">
            {LEAD_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            {!LEAD_OPTIONS.some((o) => o.v === form.lead) && <option value={form.lead}>{Math.round(form.lead / 60)} giờ trước</option>}
          </select>
        </Field>
        <Field label="Số điện thoại thử nghiệm" htmlFor="pc-phones" hint="Chỉ các số này được nhận tin trong giai đoạn thử nghiệm. Số được lưu dạng băm, không hiển thị lại; để trống nghĩa là xóa danh sách.">
          <Textarea id="pc-phones" rows={2} value={form.phones} onChange={(e) => set('phones', e.target.value)} placeholder="0901234567, 0912345678" />
        </Field>
        <label className="flex items-center gap-2 text-[12px] text-[#374151]">
          <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} className="w-3.5 h-3.5 accent-[#0F766E]" />
          Bật kết nối (cho phép đọc lịch hẹn từ PETCLINIC)
        </label>

        <div className="pt-3 border-t border-[#F1F5F9] space-y-2">
          <Button type="button" variant="outline" icon={<Plug size={13} />} onClick={() => void test()} loading={testing} disabled={!pc?.active} className="text-[12px]">
            {testing ? 'Đang kiểm tra...' : 'Kiểm tra kết nối & xem trước dữ liệu'}
          </Button>
          <p className="flex items-start gap-1.5 text-[11px] text-[#9CA3AF]"><Info size={12} className="shrink-0 mt-0.5" />{pc?.active ? 'Dùng cấu hình đã lưu. Chỉ xem trước, không gửi tin thật.' : 'Lưu và bật kết nối trước khi kiểm tra. Bước cấu hình không bao giờ gửi tin thật.'}</p>
        </div>
      </form>
    </Modal>
  )
}

