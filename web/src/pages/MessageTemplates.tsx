import { Fragment, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Plus, FileText, Edit2, AlertCircle } from 'lucide-react'
import { Alert, Button, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Skeleton, Switch, Textarea, cardClass, cx, useToast } from '@/components/ui'
import { api } from '@/lib/api'
import { useCrm } from '@/lib/data'
import { connectionName, fmtDate } from '@/lib/format'
import type { MessageTemplate } from '@/lib/types'

const STANDARD_VARS = ['ownerName', 'petName', 'appointmentTime', 'serviceName', 'clinicName']
const VAR_LABEL: Record<string, string> = { ownerName: 'Tên khách hàng', petName: 'Tên thú cưng', appointmentTime: 'Thời gian hẹn', serviceName: 'Dịch vụ', clinicName: 'Phòng khám' }
// Chỉ dùng cho khung xem trước; không phải dữ liệu khách hàng.
const SAMPLE: Record<string, string> = { ownerName: 'Trần Thị Lan', petName: 'Bông (Poodle)', appointmentTime: '09:30 Thứ Tư 24/09', serviceName: 'Khám tổng quát', clinicName: 'VETCLINIC CN Quận 1' }
const PLACEHOLDER = /{{\s*([a-zA-Z0-9_]+)\s*}}/g

function placeholders(body: string) { return [...body.matchAll(PLACEHOLDER)].map((m) => m[1]) }

/** Xem trước an toàn: dựng React node, không dùng innerHTML. */
function Preview({ body }: { body: string }): ReactNode {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of body.matchAll(PLACEHOLDER)) {
    parts.push(body.slice(last, m.index))
    parts.push(<strong key={m.index}>{SAMPLE[m[1]] ?? `{{${m[1]}}}`}</strong>)
    last = (m.index || 0) + m[0].length
  }
  parts.push(body.slice(last))
  return <span className="whitespace-pre-wrap">{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</span>
}

type Draft = { id?: string; installationId: string; code: string; body: string; active: boolean; allowed: string[] }

export default function MessageTemplates() {
  const crm = useCrm()
  const toast = useToast()
  const templates = crm.templates.data || []
  const installations = (crm.installations.data || []).filter((i) => i.status !== 'REVOKED')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const canManage = crm.can('crm.templates.manage')

  const openNew = () => setEditing({ installationId: installations[0]?.id || '', code: '', body: '', active: true, allowed: [...STANDARD_VARS] })
  const openEdit = (t: MessageTemplate) => setEditing({ id: t.id, installationId: t.installationId, code: t.code, body: t.body, active: t.active, allowed: [...new Set([...STANDARD_VARS, ...t.allowedVariables])] })

  const toggle = async (t: MessageTemplate) => {
    setToggling(t.id)
    try {
      await api.setTemplateActive(t.id, !t.active)
      toast('success', t.active ? `Đã tắt mẫu ${t.code}.` : `Đã bật mẫu ${t.code}.`)
      await crm.reload()
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Không cập nhật được mẫu tin.') } finally { setToggling(null) }
  }

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader crumb="Mẫu tin nhắn" title="Mẫu tin nhắn" description="Quản lý nội dung tin nhắc lịch gửi qua Zalo."
        actions={canManage && <Button icon={<Plus size={14} />} onClick={openNew} disabled={!installations.length} title={installations.length ? undefined : 'Cần có kết nối dữ liệu trước'}>Tạo mẫu mới</Button>} />

      {crm.templates.error ? <div className={cardClass}><ErrorState message={crm.templates.error} onRetry={() => void crm.reload()} /></div>
        : crm.loading && !crm.templates.data ? <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">{[0, 1, 2].map((i) => <div key={i} className={cx(cardClass, 'p-4 space-y-3')}><Skeleton className="w-8 h-8" /><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-3/4" /></div>)}</div>
        : templates.length === 0 ? <div className={cardClass}><EmptyState icon={<FileText size={18} />} title="Chưa có mẫu tin nhắn" description={installations.length ? 'Tạo mẫu nhắc lịch đầu tiên. Mẫu chỉ được dùng các biến đã khai báo.' : 'Cần có kết nối dữ liệu trước khi tạo mẫu tin.'} action={installations.length && canManage ? <Button size="sm" onClick={openNew}>Tạo mẫu mới</Button> : undefined} /></div>
        : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {templates.map((t) => {
              const inst = installations.find((i) => i.id === t.installationId)
              return (
                <div key={t.id} role="button" tabIndex={0} onClick={() => setSelectedId(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') setSelectedId(t.id) }}
                  className={cx('bg-white border rounded-[10px] p-4 cursor-pointer shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-colors', selectedId === t.id ? 'border-[#0F766E]' : 'border-[#E2E8F0] hover:border-[#CBD5E1]')}>
                  <div className="flex items-start justify-between mb-2">
                    <div className="w-8 h-8 rounded-lg bg-[#F0FDFA] flex items-center justify-center"><FileText size={15} className="text-[#0F766E]" /></div>
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <span className={cx('text-[10px] font-medium px-2 py-0.5 rounded-full', t.active ? 'bg-[#F0FDF4] text-[#16A34A]' : 'bg-[#F9FAFB] text-[#9CA3AF]')}>{t.active ? 'Đang bật' : 'Đã tắt'}</span>
                      <Switch checked={t.active} disabled={toggling === t.id || !canManage} label={t.active ? 'Tắt mẫu' : 'Bật mẫu'} onChange={() => void toggle(t)} />
                    </div>
                  </div>
                  <div className="text-[13px] font-semibold text-[#172B2A] mb-0.5 font-mono break-all">{t.code}</div>
                  <div className="text-[10px] text-[#9CA3AF] mb-2">{inst ? connectionName(inst) : 'Kết nối dữ liệu'}</div>
                  <p className="text-[11px] text-[#6B7280] line-clamp-2 leading-relaxed">{t.body.split('\n')[0]}</p>
                  {selectedId === t.id && <div className="mt-3 bg-[#F0F0F0] rounded-lg p-3 text-[12px] text-[#172B2A] leading-relaxed"><Preview body={t.body} /></div>}
                  <div className="flex items-center justify-between mt-3 pt-2 border-t border-[#F8FAFC]">
                    <span className="text-[10px] text-[#9CA3AF]">Cập nhật {fmtDate(t.updatedAt)}</span>
                    {canManage && <button onClick={(e) => { e.stopPropagation(); openEdit(t) }} className="flex items-center gap-1 text-[11px] text-[#0F766E] hover:underline"><Edit2 size={10} /> Chỉnh sửa</button>}
                  </div>
                </div>
              )
            })}
          </div>
        )}

      {editing && <Editor draft={editing} installations={installations} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void crm.reload() }} />}
    </div>
  )
}

function Editor({ draft: initial, installations, onClose, onSaved }: { draft: Draft; installations: { id: string; sourceProduct: string }[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [d, setD] = useState(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState('')
  const [saving, setSaving] = useState(false)
  const used = useMemo(() => [...new Set(placeholders(d.body))], [d.body])
  const undeclared = used.filter((v) => !d.allowed.includes(v))

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setServerError('')
    const err: Record<string, string> = {}
    if (!d.installationId) err.installationId = 'Chọn kết nối dữ liệu.'
    if (!/^[A-Z0-9_]{3,100}$/.test(d.code)) err.code = 'Mã mẫu 3–100 ký tự, chỉ gồm chữ in hoa, số và dấu gạch dưới.'
    if (!d.body.trim()) err.body = 'Nhập nội dung tin nhắn.'
    else if (d.body.length > 2000) err.body = 'Nội dung tối đa 2.000 ký tự.'
    else if (undeclared.length) err.body = `Biến chưa khai báo: ${undeclared.map((v) => `{{${v}}}`).join(', ')}`
    setErrors(err)
    if (Object.keys(err).length) return
    setSaving(true)
    try {
      await api.saveTemplate({ installationId: d.installationId, code: d.code, body: d.body, allowedVariables: d.allowed, active: d.active })
      toast('success', `Đã lưu mẫu ${d.code}.`)
      onSaved()
    } catch (e2) { setServerError(e2 instanceof Error ? e2.message : 'Không lưu được mẫu tin.') } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} width={760} title={d.id ? 'Chỉnh sửa mẫu' : 'Tạo mẫu mới'}
      footer={<>
        <Button variant="secondary" className="flex-1 text-[12px]" onClick={onClose} disabled={saving}>Hủy</Button>
        <Button type="submit" form="template-form" className="flex-1 text-[12px]" loading={saving}>{saving ? 'Đang lưu…' : 'Lưu mẫu'}</Button>
      </>}>
      <form id="template-form" onSubmit={submit} noValidate className="p-5">
        {serverError && <Alert kind="error" className="mb-4">{serverError}</Alert>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="space-y-3">
            <Field label="Kết nối dữ liệu" required htmlFor="tpl-inst" error={errors.installationId}>
              <Select id="tpl-inst" value={d.installationId} disabled={!!d.id} onChange={(e) => setD({ ...d, installationId: e.target.value })} className="w-full h-9">
                {installations.map((i) => <option key={i.id} value={i.id}>{connectionName(i)}</option>)}
              </Select>
            </Field>
            <Field label="Mã mẫu" required htmlFor="tpl-code" error={errors.code} hint={d.id ? 'Mã mẫu không đổi được sau khi tạo.' : 'Ví dụ: PC_APPT_REMINDER_V1'}>
              <Input id="tpl-code" value={d.code} disabled={!!d.id} onChange={(e) => setD({ ...d, code: e.target.value.toUpperCase() })} placeholder="PC_APPT_REMINDER_V1" className="font-mono" invalid={!!errors.code} />
            </Field>
            <div>
              <label htmlFor="tpl-body" className="block text-[12px] font-medium text-[#374151] mb-1.5">Nội dung tin nhắn <span className="text-[#DC2626]">*</span></label>
              <Textarea id="tpl-body" rows={8} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} className="font-mono" invalid={!!errors.body} />
              <div className="flex justify-between gap-2 mt-1">
                <span className={cx('text-[10px]', d.body.length > 2000 ? 'text-[#DC2626]' : 'text-[#9CA3AF]')}>{d.body.length}/2.000 ký tự</span>
                {(errors.body || undeclared.length > 0) && <span className="flex items-center gap-1 text-[10px] text-[#DC2626] text-right"><AlertCircle size={10} className="shrink-0" /> {errors.body || `Biến chưa khai báo: ${undeclared.map((v) => `{{${v}}}`).join(', ')}`}</span>}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-[#374151] mb-1.5">Chèn biến</div>
              <div className="flex flex-wrap gap-1.5">
                {d.allowed.map((v) => (
                  <button type="button" key={v} title={VAR_LABEL[v]} onClick={() => setD((x) => ({ ...x, body: `${x.body}{{${v}}}` }))} className="text-[10px] font-mono bg-[#F0FDFA] text-[#0F766E] border border-[#99F6E4] px-2 py-1 rounded hover:bg-[#CCFBF1] transition-colors">{`{{${v}}}`}</button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-[12px] text-[#374151]"><Switch checked={d.active} onChange={(v) => setD({ ...d, active: v })} label="Bật mẫu tin" /> {d.active ? 'Mẫu đang bật' : 'Mẫu đang tắt'}</label>
          </div>
          <div>
            <div className="text-[12px] font-medium text-[#374151] mb-2">Xem trước tin nhắn Zalo</div>
            <div className="bg-[#F0F0F0] rounded-xl p-4 min-h-[200px]">
              <div className="flex items-end gap-2">
                <div className="w-7 h-7 rounded-full bg-[#0F766E] flex items-center justify-center text-[10px] text-white shrink-0">VC</div>
                <div className="bg-white rounded-xl rounded-bl-sm px-3 py-2.5 max-w-[85%] text-[12px] text-[#172B2A] leading-relaxed shadow-sm break-words">
                  {d.body ? <Preview body={d.body} /> : <span className="text-[#9CA3AF]">Nội dung tin nhắn sẽ hiển thị ở đây</span>}
                </div>
              </div>
              <div className="text-center text-[10px] text-[#9CA3AF] mt-3">Dữ liệu minh họa · không phải thông tin khách hàng thật</div>
            </div>
          </div>
        </div>
      </form>
    </Modal>
  )
}
