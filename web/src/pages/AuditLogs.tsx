import { useCallback, useEffect, useState } from 'react'
import { Search, CheckCircle2, XCircle, Minus, ScrollText } from 'lucide-react'
import { DataTable, Drawer, EmptyState, ErrorState, InfoList, PageHeader, Pagination, SectionLabel, Select, TableSkeleton, cellClass, cx, rowClass } from '@/components/ui'
import { api } from '@/lib/api'
import { useCrm } from '@/lib/data'
import { actionLabel, actorLabel, connectionName, fmtDateTime, redactMetadata } from '@/lib/format'
import type { AuditEntry, AuditPage } from '@/lib/types'

type Result = 'success' | 'failed' | 'no_change'
const resultOf = (r: string): Result => (r === 'SUCCESS' ? 'success' : r === 'NO_CHANGE' ? 'no_change' : 'failed')
function ResultBadge({ result }: { result: Result }) {
  if (result === 'success') return <span className="flex items-center gap-1 text-[11px] text-[#16A34A] whitespace-nowrap"><CheckCircle2 size={12} />Thành công</span>
  if (result === 'failed') return <span className="flex items-center gap-1 text-[11px] text-[#DC2626] whitespace-nowrap"><XCircle size={12} />Thất bại</span>
  return <span className="flex items-center gap-1 text-[11px] text-[#9CA3AF] whitespace-nowrap"><Minus size={12} />Không đổi</span>
}
const TARGET_LABEL: Record<string, string> = { Installation: 'Kết nối dữ liệu', CareJob: 'Tác vụ chăm sóc', MessageTemplate: 'Mẫu tin nhắn', ZaloAccount: 'Tài khoản Zalo', PetclinicConnection: 'Kết nối PETCLINIC' }
const targetLabel = (t: string | null) => (t ? TARGET_LABEL[t] || t : '—')

export default function AuditLogs() {
  const crm = useCrm()
  const installations = crm.installations.data || []
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<'' | Result>('')
  const [action, setAction] = useState('')
  const [inst, setInst] = useState('')
  const [page, setPage] = useState(1)
  const [state, setState] = useState<{ loading: boolean; data: AuditPage | null; error: string | null }>({ loading: true, data: null, error: null })
  const [drawer, setDrawer] = useState<AuditEntry | null>(null)

  useEffect(() => { const t = window.setTimeout(() => { setSearch(q.trim()); setPage(1) }, 300); return () => window.clearTimeout(t) }, [q])
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    try { setState({ loading: false, data: await api.audit({ q: search, action, installationId: inst, result, page, pageSize: 25 }), error: null }) }
    catch (e) { setState({ loading: false, data: null, error: e instanceof Error ? e.message : 'Lỗi' }) }
  }, [search, action, inst, result, page])
  useEffect(() => { void load() }, [load])
  const d = state.data
  const logs = d?.items || []
  const instName = (id: string | null) => { const i = installations.find((x) => x.id === id); return i ? connectionName(i) : '—' }
  // Máy chủ đã che khóa/số điện thoại; giao diện che thêm một lớp phòng vệ.
  const meta = drawer?.metadata && typeof drawer.metadata === 'object' ? (redactMetadata(drawer.metadata) as Record<string, unknown>) : null

  return (
    <div className="flex h-full">
      <div className="flex-1 p-4 sm:p-6 space-y-5 overflow-auto min-w-0">
        <PageHeader crumb="Nhật ký" title="Nhật ký hoạt động" description="Ghi nhận các thao tác và sự kiện chăm sóc khách hàng của doanh nghiệp." />
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-[300px]">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9CA3AF]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm hành động, người thực hiện..." aria-label="Tìm nhật ký"
              className="w-full h-8 pl-8 pr-3 border border-[#E2E8F0] rounded-lg text-[12px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20 focus:border-[#0F766E]" />
          </div>
                    <Select aria-label="Hành động" value={action} onChange={(e) => { setAction(e.target.value); setPage(1) }}><option value="">Tất cả hành động</option>{(d?.actions || []).map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}</Select>
                    <Select aria-label="Kết nối dữ liệu" value={inst} onChange={(e) => { setInst(e.target.value); setPage(1) }}><option value="">Tất cả kết nối</option>{installations.map((i) => <option key={i.id} value={i.id}>{connectionName(i)}</option>)}</Select>
          <Select aria-label="Kết quả" value={result} onChange={(e) => { setResult(e.target.value as '' | Result); setPage(1) }}>
            <option value="">Tất cả kết quả</option><option value="success">Thành công</option><option value="failed">Thất bại</option><option value="no_change">Không thay đổi</option>
          </Select>
          <div className="ml-auto text-[12px] text-[#6B7280]">{d ? `${d.total} mục` : ''}</div>
        </div>
        <DataTable minWidth={760} headers={['Thời gian', 'Người thực hiện', 'Hành động', 'Đối tượng', 'Kết quả', '']}
          footer={d && d.total > 0 ? <Pagination page={d.page} pageCount={Math.max(1, Math.ceil(d.total / d.pageSize))} total={d.total} from={(d.page - 1) * d.pageSize + 1} to={Math.min(d.page * d.pageSize, d.total)} unit="mục" onPage={setPage} /> : undefined}>
          {state.error ? <tr><td colSpan={6}><ErrorState message={state.error} onRetry={() => void load()} /></td></tr>
            : state.loading && !d ? <tr><td colSpan={6}><TableSkeleton rows={8} cols={5} /></td></tr>
            : logs.length === 0 ? <tr><td colSpan={6}><EmptyState icon={<ScrollText size={18} />} title={search || action || inst || result ? 'Không có mục phù hợp' : 'Chưa có nhật ký'} /></td></tr>
            : logs.map((log) => (
              <tr key={log.id} onClick={() => setDrawer(log)} className={cx(rowClass, 'cursor-pointer', drawer?.id === log.id && 'bg-[#F0FDFA]')}>
                <td className={cx(cellClass, 'text-[11px] font-mono text-[#9CA3AF] whitespace-nowrap')}>{fmtDateTime(log.createdAt)}</td>
                <td className={cx(cellClass, 'text-[12px] text-[#374151]')}>{log.actorId || actorLabel(log.actorType)}</td>
                <td className={cx(cellClass, 'text-[12px] font-medium text-[#172B2A]')}>{actionLabel(log.action)}</td>
                <td className={cx(cellClass, 'text-[11px] text-[#6B7280]')}>{targetLabel(log.targetType)}</td>
                <td className={cellClass}><ResultBadge result={resultOf(log.result)} /></td>
                <td className={cellClass}><button className="text-[11px] text-[#0F766E] hover:underline">Chi tiết</button></td>
              </tr>
            ))}
        </DataTable>
      </div>
      {drawer && (
        <Drawer open title="Chi tiết nhật ký" onClose={() => setDrawer(null)}>
          <ResultBadge result={resultOf(drawer.result)} />
          <InfoList title="Thông tin" rows={[
            ['Thời gian', fmtDateTime(drawer.createdAt)],
            ['Người thực hiện', `${drawer.actorId || '—'} (${actorLabel(drawer.actorType)})`],
            ['Hành động', actionLabel(drawer.action)],
            ['Đối tượng', targetLabel(drawer.targetType)],
            ['Mã đối tượng', <span className="font-mono text-[11px]">{drawer.targetId || '—'}</span>],
            ['Kết nối dữ liệu', instName(drawer.installationId)],
            ...(drawer.reason ? [['Lý do', String(redactMetadata(drawer.reason))] as [string, string]] : []),
          ]} />
          {meta && Object.keys(meta).length > 0 && (
            <div>
              <SectionLabel>Dữ liệu bổ sung</SectionLabel>
              <div className="bg-[#F1F5F9] rounded-lg p-3 font-mono text-[11px] text-[#374151] space-y-1 break-all">
                {Object.entries(meta).map(([k, v]) => <div key={k}><span className="text-[#9CA3AF]">{k}:</span> {typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>)}
              </div>
              <p className="text-[10px] text-[#9CA3AF] mt-1">Khóa, mã truy cập và số điện thoại luôn được ẩn.</p>
            </div>
          )}
        </Drawer>
      )}
    </div>
  )
}
