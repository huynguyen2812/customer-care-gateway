import { useCallback, useEffect, useState } from 'react'
import { Search, UserX, AlertTriangle } from 'lucide-react'
import { ConfirmDialog, DataTable, EmptyState, ErrorState, Field, PageHeader, Pagination, TableSkeleton, Textarea, cellClass, rowClass, useToast } from '@/components/ui'
import { api } from '@/lib/api'
import { useCrm } from '@/lib/data'
import { connectionName, fmtDate } from '@/lib/format'
import type { OptOut, Page } from '@/lib/types'

const PAGE_SIZE = 20
const SOURCE_LABEL: Record<string, string> = { SOURCE_PRODUCT: 'Nguồn dữ liệu báo', CUSTOMER: 'Khách tự từ chối', STAFF: 'Nhân viên cập nhật', SYSTEM: 'Hệ thống tự động' }

export default function OptoutList() {
  const crm = useCrm()
  const toast = useToast()
  const canManage = crm.can('crm.optouts.manage')
  const installations = crm.installations.data || []
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [state, setState] = useState<{ loading: boolean; data: Page<OptOut> | null; error: string | null }>({ loading: true, data: null, error: null })
  const [confirm, setConfirm] = useState<OptOut | null>(null)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { const t = window.setTimeout(() => { setSearch(q.trim()); setPage(1) }, 300); return () => window.clearTimeout(t) }, [q])
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    try { setState({ loading: false, data: await api.optOuts({ q: search, page, pageSize: PAGE_SIZE }), error: null }) }
    catch (e) { setState({ loading: false, data: null, error: e instanceof Error ? e.message : 'Lỗi' }) }
  }, [search, page])
  useEffect(() => { void load() }, [load])

  const remove = async () => {
    if (!confirm) return
    if (reason.trim().length < 5) { setReasonError('Cần nhập lý do (tối thiểu 5 ký tự).'); return }
    setBusy(true); setError('')
    try {
      await api.removeOptOut(confirm.id, reason.trim())
      toast('success', 'Đã gỡ khỏi danh sách từ chối nhận tin.')
      setConfirm(null); setReason('')
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Không thực hiện được.') } finally { setBusy(false) }
  }

  const d = state.data
  const instName = (id: string) => { const i = installations.find((x) => x.id === id); return i ? connectionName(i) : '—' }
  const cols = canManage ? 6 : 5
  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader crumb="Từ chối nhận tin" title="Danh sách từ chối nhận tin" description="Các số điện thoại đã từ chối nhận tin nhắc lịch." />
      <div className="flex items-center gap-2 bg-[#FFFBEB] border border-[#FDE68A] rounded-lg px-3 py-2.5">
        <AlertTriangle size={13} className="text-[#D97706] shrink-0" />
        <span className="text-[11px] text-[#B45309]">Số điện thoại được che một phần. Việc gỡ khỏi danh sách cần lý do và sẽ được ghi vào nhật ký.</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-[300px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9CA3AF]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm số đã che, lý do..." aria-label="Tìm số điện thoại"
            className="w-full h-8 pl-8 pr-3 border border-[#E2E8F0] rounded-lg text-[12px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20 focus:border-[#0F766E]" />
        </div>
        <div className="ml-auto text-[12px] text-[#6B7280]">{d ? `${d.total} bản ghi` : ''}</div>
      </div>
      <DataTable headers={['Số điện thoại', 'Nguồn từ chối', 'Lý do', 'Ngày từ chối', 'Kết nối dữ liệu', ...(canManage ? [''] : [])]} minWidth={720}
        footer={d && d.total > 0 ? <Pagination page={d.page} pageCount={Math.max(1, Math.ceil(d.total / d.pageSize))} total={d.total} from={(d.page - 1) * d.pageSize + 1} to={Math.min(d.page * d.pageSize, d.total)} unit="bản ghi" onPage={setPage} /> : undefined}>
        {state.error ? <tr><td colSpan={cols}><ErrorState message={state.error} onRetry={() => void load()} /></td></tr>
          : state.loading && !d ? <tr><td colSpan={cols}><TableSkeleton rows={4} cols={5} /></td></tr>
          : !d || d.items.length === 0 ? <tr><td colSpan={cols}><EmptyState icon={<UserX size={18} />} title={search ? 'Không có bản ghi phù hợp' : 'Chưa có khách từ chối nhận tin'} /></td></tr>
          : d.items.map((row) => (
            <tr key={row.id} className={rowClass}>
              <td className={`${cellClass} text-[12px] font-mono font-semibold text-[#172B2A]`}>{row.maskedPhone || 'Số đã ẩn'}</td>
              <td className={`${cellClass} text-[12px] text-[#374151]`}>{SOURCE_LABEL[row.source] || row.source}</td>
              <td className={`${cellClass} text-[12px] text-[#6B7280]`}>{row.reason || '—'}</td>
              <td className={`${cellClass} text-[12px] text-[#374151]`}>{fmtDate(row.createdAt)}</td>
              <td className={`${cellClass} text-[12px] text-[#374151]`}>{instName(row.installationId)}</td>
              {canManage && <td className={cellClass}><button onClick={() => { setConfirm(row); setReason(''); setReasonError(''); setError('') }} className="text-[11px] text-[#DC2626] hover:underline">Gỡ khỏi danh sách</button></td>}
            </tr>
          ))}
      </DataTable>

      <ConfirmDialog open={!!confirm} icon={<UserX size={18} />} title="Xác nhận gỡ khỏi danh sách" subtitle="Hành động này sẽ được ghi nhật ký"
        confirmLabel="Xác nhận gỡ" loading={busy} error={error} onCancel={() => setConfirm(null)} onConfirm={() => void remove()}>
        <p className="mb-3">Số điện thoại <strong className="font-mono">{confirm?.maskedPhone || 'đã ẩn'}</strong> sẽ được gỡ khỏi danh sách từ chối và có thể nhận tin trở lại.</p>
        <Field label="Lý do gỡ" required htmlFor="optout-reason" error={reasonError}>
          <Textarea id="optout-reason" rows={2} value={reason} onChange={(e) => { setReason(e.target.value); setReasonError('') }} placeholder="Ví dụ: Khách gọi điện yêu cầu nhận lại tin nhắc lịch" invalid={!!reasonError} maxLength={300} />
        </Field>
      </ConfirmDialog>
    </div>
  )
}
