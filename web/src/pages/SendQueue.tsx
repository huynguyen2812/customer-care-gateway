import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Search, Clock, Send, CheckCircle2, XCircle, Ban, AlertCircle, RefreshCw, Inbox, X } from 'lucide-react'
import {
  Badge, Button, Checkbox, ConfirmDialog, DataTable, Drawer, EmptyState, ErrorState, InfoList, PageHeader, Pagination,
  SectionLabel, Select, TableSkeleton, cellClass, cx, rowClass, useToast,
} from '@/components/ui'
import { api } from '@/lib/api'
import { useCrm } from '@/lib/data'
import { ATTEMPT_STATUS, CONSENT, JOB_STATUS, connectionName, eventLabel, failureLabel, fmtDateTime, productLabel } from '@/lib/format'
import type { CareJob, CareJobDetail, CareJobStatus, InstallationSummary, JobPage } from '@/lib/types'

const PAGE_SIZE = 20
const CANCELLABLE: CareJobStatus[] = ['QUEUED', 'PROCESSING']
const FAILED_GROUP: CareJobStatus[] = ['FAILED', 'ACCOUNT_RESTRICTED', 'RECIPIENT_NOT_FOUND']
const STAT = [
  { key: 'pending', label: 'Đang chờ', Icon: Clock, color: '#D97706', bg: '#FFFBEB' },
  { key: 'processing', label: 'Đang gửi', Icon: Send, color: '#1D4ED8', bg: '#EFF6FF' },
  { key: 'sent', label: 'Đã gửi', Icon: CheckCircle2, color: '#16A34A', bg: '#F0FDF4' },
  { key: 'failed', label: 'Thất bại', Icon: XCircle, color: '#DC2626', bg: '#FEF2F2' },
  { key: 'cancelled', label: 'Đã hủy', Icon: Ban, color: '#6B7280', bg: '#F9FAFB' },
] as const

/** Tài khoản Zalo đã được chọn cho tác vụ (giữ cố định khi thử lại); '—' khi chưa chọn. */
function accountOf(job: CareJob) {
  if (!job.selectedZaloAccountId) return '—'
  return job.selectedZaloAccountName || (job.selectedChannel === 'ZNS' ? 'Zalo OA' : 'Zalo')
}

export default function SendQueue() {
  const crm = useCrm()
  const toast = useToast()
  const canCancel = crm.can('crm.jobs.cancel')
  const installations = crm.installations.data || []
  const instById = useMemo(() => new Map(installations.map((i) => [i.id, i])), [installations])

  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [statusGroup, setStatusGroup] = useState('')
  const [source, setSource] = useState('')
  const [template, setTemplate] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [state, setState] = useState<{ loading: boolean; data: JobPage | null; error: string | null }>({ loading: true, data: null, error: null })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<CareJob | null>(null)
  const [confirm, setConfirm] = useState<string[] | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')

  useEffect(() => { const t = window.setTimeout(() => { setSearch(q.trim()); setPage(1) }, 300); return () => window.clearTimeout(t) }, [q])
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    try { setState({ loading: false, data: await api.jobs({ q: search, status: statusGroup, installationId: source, templateCode: template, from, to, page, pageSize: PAGE_SIZE }), error: null }) }
    catch (e) { setState({ loading: false, data: null, error: e instanceof Error ? e.message : 'Lỗi' }) }
  }, [search, statusGroup, source, template, from, to, page])
  useEffect(() => { void load() }, [load])

  const set = (fn: (v: string) => void) => (v: string) => { fn(v); setPage(1) }
  const d = state.data
  const rows = d?.items || []
  const pageCancellable = rows.filter((j) => CANCELLABLE.includes(j.status))
  const allSelected = pageCancellable.length > 0 && pageCancellable.every((j) => selected.has(j.id))
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const hasFilters = q || statusGroup || source || template || from || to

  const doCancel = async () => {
    if (!confirm) return
    setCancelling(true); setCancelError('')
    try {
      const out = await api.cancelJobs(confirm)
      const failed = out.results.filter((r) => !r.cancelled).length
      if (failed) setCancelError(`${out.cancelled ? `Đã hủy ${out.cancelled}, ` : ''}${failed} tác vụ không hủy được (có thể đã được gửi).`)
      else { setConfirm(null); setDrawer(null); toast('success', `Đã hủy ${out.cancelled} tác vụ chăm sóc.`) }
      setSelected(new Set())
      await load()
    } catch (e) { setCancelError(e instanceof Error ? e.message : 'Không hủy được.') } finally { setCancelling(false) }
  }

  const colSpan = canCancel ? 11 : 10
  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 p-4 sm:p-6 space-y-4 overflow-auto">
        <PageHeader crumb="Hàng đợi & lịch sử" title="Hàng đợi & lịch sử gửi" description="Theo dõi và quản lý toàn bộ tác vụ chăm sóc khách hàng."
          actions={<Button variant="secondary" size="sm" icon={<RefreshCw size={12} className={state.loading ? 'animate-spin' : ''} />} onClick={() => void load()}>Làm mới</Button>} />

        <div className="flex gap-3 overflow-x-auto pb-1">
          {STAT.map(({ key, label, Icon, color, bg }) => {
            const active = statusGroup === key
            return (
              <button key={key} onClick={() => set(setStatusGroup)(active ? '' : key)} aria-pressed={active}
                className={cx('flex items-center gap-2 bg-white border rounded-lg px-3 py-2.5 transition-colors shrink-0', active ? 'border-[#0F766E] ring-1 ring-[#0F766E]/20' : 'border-[#E2E8F0] hover:border-[#CBD5E1]')}>
                <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: bg, color }}><Icon size={12} /></div>
                <div className="text-left">
                  <div className="text-[14px] font-bold text-[#172B2A] leading-none">{d ? d.stats[key] : '—'}</div>
                  <div className="text-[10px] text-[#6B7280]">{label}</div>
                </div>
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-[300px]">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9CA3AF]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm mã tham chiếu, sự kiện, mẫu tin..." aria-label="Tìm tác vụ"
              className="w-full h-8 pl-8 pr-3 border border-[#E2E8F0] rounded-lg text-[12px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20 focus:border-[#0F766E]" />
          </div>
          <Select aria-label="Trạng thái" value={statusGroup} onChange={(e) => set(setStatusGroup)(e.target.value)}>
            <option value="">Tất cả trạng thái</option>
            {STAT.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </Select>
          <Select aria-label="Nguồn dữ liệu" value={source} onChange={(e) => set(setSource)(e.target.value)}>
            <option value="">Tất cả nguồn</option>
            {installations.map((i) => <option key={i.id} value={i.id}>{connectionName(i)}</option>)}
          </Select>
          <Select aria-label="Mẫu tin" value={template} onChange={(e) => set(setTemplate)(e.target.value)}>
            <option value="">Tất cả mẫu tin</option>
            {(d?.templateCodes || []).map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
          <div className="flex items-center gap-1">
            <input type="date" aria-label="Từ ngày" value={from} onChange={(e) => set(setFrom)(e.target.value)} className="h-8 px-2 border border-[#E2E8F0] rounded-lg text-[12px] bg-white text-[#374151] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20" />
            <span className="text-[#9CA3AF] text-[12px]">—</span>
            <input type="date" aria-label="Đến ngày" value={to} onChange={(e) => set(setTo)(e.target.value)} className="h-8 px-2 border border-[#E2E8F0] rounded-lg text-[12px] bg-white text-[#374151] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20" />
          </div>
          {hasFilters && <button onClick={() => { setQ(''); setStatusGroup(''); setSource(''); setTemplate(''); setFrom(''); setTo(''); setPage(1) }} className="h-8 px-2 text-[12px] text-[#6B7280] hover:text-[#172B2A] flex items-center gap-1"><X size={12} />Xóa lọc</button>}
          {canCancel && selected.size > 0 && (
            <button onClick={() => { setCancelError(''); setConfirm([...selected]) }} className="h-8 px-3 bg-[#FEF2F2] border border-[#FECACA] rounded-lg text-[12px] text-[#DC2626] font-medium hover:bg-[#FEE2E2] transition-colors">
              Hủy {selected.size} tin đã chọn
            </button>
          )}
          <div className="ml-auto text-[12px] text-[#6B7280]">{d ? `${d.total} bản ghi` : ''}</div>
        </div>

        <DataTable minWidth={1040}
          headers={[
            ...(canCancel ? [<Checkbox key="all" label="Chọn tất cả tin chưa gửi trên trang" checked={allSelected} onChange={() => setSelected((prev) => { const n = new Set(prev); pageCancellable.forEach((j) => allSelected ? n.delete(j.id) : n.add(j.id)); return n })} />] : []),
            'Mã tham chiếu', 'Sự kiện', 'Nguồn dữ liệu', 'Mẫu tin', 'Tài khoản Zalo', 'Thời gian dự kiến', 'Đồng ý nhận tin', 'Trạng thái', 'Thử lại', '',
          ]}
          footer={d && d.total > 0 ? <Pagination page={d.page} pageCount={Math.max(1, Math.ceil(d.total / d.pageSize))} total={d.total} from={(d.page - 1) * d.pageSize + 1} to={Math.min(d.page * d.pageSize, d.total)} unit="bản ghi" onPage={setPage} /> : undefined}
        >
          {state.error ? <tr><td colSpan={colSpan}><ErrorState message={state.error} onRetry={() => void load()} /></td></tr>
            : state.loading && !d ? <tr><td colSpan={colSpan}><TableSkeleton rows={8} cols={8} /></td></tr>
            : rows.length === 0 ? <tr><td colSpan={colSpan}>{hasFilters
              ? <EmptyState icon={<Search size={18} />} title="Không có tác vụ phù hợp" description="Thử đổi từ khóa hoặc bộ lọc." />
              : <EmptyState icon={<Inbox size={18} />} title="Chưa có tác vụ chăm sóc" description="Khi nguồn dữ liệu tạo lịch nhắc, các tác vụ sẽ xuất hiện tại đây." />}</td></tr>
            : rows.map((row) => {
              const s = JOB_STATUS[row.status]; const c = CONSENT[row.consentStatus]
              return (
                <tr key={row.id} onClick={() => setDrawer(row)} className={cx(rowClass, 'cursor-pointer', drawer?.id === row.id && 'bg-[#F0FDFA]')}>
                  {canCancel && (
                    <td className={cellClass} onClick={(e) => e.stopPropagation()}>
                      {CANCELLABLE.includes(row.status) ? <Checkbox label={`Chọn ${row.externalReferenceId}`} checked={selected.has(row.id)} onChange={() => toggle(row.id)} /> : <span className="inline-block w-3.5" />}
                    </td>
                  )}
                  <td className={cellClass}><div className="text-[11px] font-mono text-[#172B2A] max-w-[160px] truncate" title={row.externalReferenceId}>{row.externalReferenceId}</div></td>
                  <td className={cx(cellClass, 'text-[12px] text-[#374151] whitespace-nowrap')}>{eventLabel(row.eventType)}</td>
                  <td className={cx(cellClass, 'text-[12px] text-[#374151] whitespace-nowrap')}>{productLabel(row.sourceProduct)}</td>
                  <td className={cx(cellClass, 'text-[11px] font-mono text-[#6B7280]')}>{row.templateCode}</td>
                  <td className={cx(cellClass, 'text-[12px] text-[#374151]')}><div className="max-w-[140px] truncate" title={accountOf(row)}>{accountOf(row)}</div></td>
                  <td className={cx(cellClass, 'text-[11px] text-[#374151] whitespace-nowrap')}>{fmtDateTime(row.scheduledAt)}</td>
                  <td className={cx(cellClass, 'whitespace-nowrap')}><span className={cx('text-[10px] font-medium', c.tone === 'green' ? 'text-[#16A34A]' : c.tone === 'red' ? 'text-[#DC2626]' : 'text-[#9CA3AF]')}>{c.label}</span></td>
                  <td className={cellClass}><Badge tone={s.tone}>{s.label}</Badge>{row.failureCode && <div className="text-[10px] text-[#9CA3AF] mt-0.5 max-w-[160px] truncate" title={failureLabel(row.failureCode)}>{failureLabel(row.failureCode)}</div>}</td>
                  <td className={cx(cellClass, 'text-[12px] text-[#6B7280] text-center')}>{row.attempts}</td>
                  <td className={cellClass}><button onClick={(e) => { e.stopPropagation(); setDrawer(row) }} className="text-[11px] text-[#0F766E] hover:underline whitespace-nowrap">Chi tiết</button></td>
                </tr>
              )
            })}
        </DataTable>
      </div>

      <JobDrawer job={drawer} installation={drawer ? instById.get(drawer.installationId) : undefined} canCancel={canCancel} onClose={() => setDrawer(null)} onCancel={(id) => { setCancelError(''); setConfirm([id]) }} />

      <ConfirmDialog open={!!confirm} tone="danger" icon={<Ban size={18} />}
        title={confirm && confirm.length > 1 ? `Hủy ${confirm.length} tin chưa gửi` : 'Hủy tin chưa gửi'}
        subtitle="Thao tác sẽ được ghi vào nhật ký" confirmLabel="Xác nhận hủy" loading={cancelling} error={cancelError}
        onCancel={() => setConfirm(null)} onConfirm={() => void doCancel()}>
        Chỉ các tin đang chờ hoặc đang xử lý mới được hủy. Tin đã gửi sẽ không bị ảnh hưởng. Khách hàng sẽ không nhận được tin đã hủy.
      </ConfirmDialog>
    </div>
  )
}

function JobDrawer({ job, installation, canCancel, onClose, onCancel }: { job: CareJob | null; installation?: InstallationSummary; canCancel: boolean; onClose: () => void; onCancel: (id: string) => void }) {
  const [detail, setDetail] = useState<{ id: string; data: CareJobDetail | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!job) return
    let alive = true
    setDetail({ id: job.id, data: null, error: null })
    api.job(job.id).then((d) => { if (alive) setDetail({ id: job.id, data: d, error: null }) }).catch((e) => { if (alive) setDetail({ id: job.id, data: null, error: e instanceof Error ? e.message : 'Lỗi' }) })
    return () => { alive = false }
  }, [job])
  if (!job) return null
  const history = detail?.id === job.id ? detail : null
  const s = JOB_STATUS[job.status]
  const failed = FAILED_GROUP.includes(job.status)
  const timeline: { time: string | null; event: string; ok: boolean | null }[] = [
    { time: job.createdAt, event: `Tạo tác vụ từ ${productLabel(job.sourceProduct)}`, ok: true },
    { time: job.scheduledAt, event: 'Thời điểm dự kiến gửi', ok: null },
  ]
  if (job.status === 'SENT') timeline.push({ time: job.sentAt, event: 'Gửi thành công qua Zalo', ok: true })
  else if (failed) timeline.push({ time: job.updatedAt, event: `Gửi thất bại: ${failureLabel(job.failureCode) || s.label}`, ok: false })
  else if (job.status === 'CANCELLED') timeline.push({ time: job.cancelledAt, event: `Đã hủy${job.failureCode ? `: ${failureLabel(job.failureCode)}` : ''}`, ok: false })
  else if (job.status === 'OPTED_OUT') timeline.push({ time: job.updatedAt, event: 'Không gửi: khách đã từ chối nhận tin', ok: false })
  else if (job.failureCode) timeline.push({ time: job.updatedAt, event: `Đang giữ lại: ${failureLabel(job.failureCode)}`, ok: null })

  return (
    <Drawer open title="Chi tiết tác vụ chăm sóc" subtitle={job.id} onClose={onClose}
      footer={canCancel && CANCELLABLE.includes(job.status) ? <Button variant="danger" className="w-full text-[12px]" onClick={() => onCancel(job.id)}>Hủy tin chưa gửi</Button> : undefined}>
      <div className="flex items-center gap-2"><Badge tone={s.tone}>{s.label}</Badge><span className="text-[11px] text-[#6B7280]">{job.attempts} lần thử</span></div>
      <InfoList title="Thông tin tác vụ" rows={[
        ['Mã tham chiếu', <span className="font-mono">{job.externalReferenceId}</span>],
        ['Sự kiện', eventLabel(job.eventType)],
        ['Nguồn dữ liệu', installation ? connectionName(installation) : productLabel(job.sourceProduct)],
        ['Mẫu tin', <span className="font-mono">{job.templateCode}</span>],
        ['Tài khoản Zalo', accountOf(job)],
        ...(job.branchId ? [['Chi nhánh', <span className="font-mono">{job.branchId}</span>] as [string, ReactNode]] : []),
        ['Đồng ý nhận tin', CONSENT[job.consentStatus].label],
        ['Dự kiến gửi', fmtDateTime(job.scheduledAt)],
        ['Đã gửi lúc', fmtDateTime(job.sentAt)],
      ]} />
      <div>
        <SectionLabel>Nội dung tin nhắn</SectionLabel>
        <div className="bg-[#F8FAFC] border border-dashed border-[#CBD5E1] rounded-lg p-3 text-[11px] text-[#6B7280]">Nội dung đã cá nhân hóa được lưu mã hóa và chưa có API xem lại. Xem mẫu <span className="font-mono">{job.templateCode}</span> tại trang Mẫu tin nhắn.</div>
      </div>
      <div>
        <SectionLabel>Timeline xử lý</SectionLabel>
        <div className="space-y-2">
          {timeline.map((t, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <div className={cx('w-4 h-4 rounded-full shrink-0 flex items-center justify-center mt-0.5 text-white', t.ok === null ? 'bg-[#CBD5E1]' : t.ok ? 'bg-[#16A34A]' : 'bg-[#DC2626]')}>
                {t.ok === null ? <Clock size={9} /> : t.ok ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
              </div>
              <div>
                <div className="text-[11px] font-mono text-[#9CA3AF]">{t.time ? fmtDateTime(t.time) : '—'}</div>
                <div className="text-[12px] text-[#172B2A]">{t.event}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <SectionLabel>Lượt gửi</SectionLabel>
        {!history || (!history.data && !history.error) ? <div className="text-[11px] text-[#9CA3AF]">Đang tải…</div>
          : history.error ? <div className="text-[11px] text-[#DC2626]">{history.error}</div>
          : (history.data!.deliveryAttempts ?? []).length === 0 ? <div className="text-[11px] text-[#9CA3AF]">Chưa có lượt gửi nào.</div>
          : <div className="space-y-2">{(history.data!.deliveryAttempts ?? []).map((a) => { const st = ATTEMPT_STATUS[a.status] || { label: a.status, tone: 'gray' as const }; return (
            <div key={a.id} className="border border-[#F1F5F9] rounded-lg p-2.5">
              <div className="flex items-center justify-between gap-2"><span className="text-[12px] font-medium text-[#172B2A] truncate">#{a.attemptNumber} · {a.accountName}</span><Badge tone={st.tone}>{st.label}</Badge></div>
              <div className="text-[11px] text-[#6B7280] mt-0.5">{fmtDateTime(a.startedAt || a.createdAt)}{a.sendCount > 1 ? ` · gửi lại cùng lượt ${a.sendCount} lần (không trùng tin)` : ''}</div>
              {a.outcomeCode && <div className="text-[11px] text-[#6B7280]">{failureLabel(a.outcomeCode)}</div>}
            </div>) })}</div>}
      </div>
      {job.failureCode === 'DELIVERY_UNCERTAIN' && <div className="bg-[#FFFBEB] border border-[#FDE68A] rounded-lg p-3 text-[11px] text-[#92400E]">Hệ thống không chắc tin đã tới khách hay chưa nên <strong>không tự gửi lại</strong> để tránh khách nhận trùng. Vui lòng kiểm tra trên Zalo của tài khoản đã gửi.</div>}
      {(job.failureCode || job.failureReason) && (failed || job.status === 'CANCELLED') && (
        <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1"><AlertCircle size={12} className="text-[#DC2626]" /><span className="text-[11px] font-semibold text-[#DC2626]">Lỗi gần nhất</span></div>
          <div className="text-[11px] text-[#DC2626]">{failureLabel(job.failureCode)}{job.failureReason ? ` — ${job.failureReason}` : ''}</div>
        </div>
      )}
    </Drawer>
  )
}
