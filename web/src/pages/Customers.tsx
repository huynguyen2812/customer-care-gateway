import { useCallback, useEffect, useState } from 'react'
import { Search, Users, ChevronRight, CheckCircle2, AlertCircle, Clock } from 'lucide-react'
import { Badge, DataTable, Drawer, EmptyState, ErrorState, InfoList, PageHeader, Pagination, SectionLabel, Select, Skeleton, TableSkeleton, cardClass, cellClass, cx, rowClass } from '@/components/ui'
import { api } from '@/lib/api'
import { CONSENT, JOB_STATUS, SOURCE_FAMILIES, eventLabel, fmtDate, fmtDateTime, fmtNumber, productLabel } from '@/lib/format'
import type { CustomerDetail, CustomerPage } from '@/lib/types'

const PAGE_SIZE = 20

/**
 * Khách hàng của doanh nghiệp, suy ra từ chính các tác vụ chăm sóc của tenant (tên/số điện thoại
 * được máy chủ giải mã và che số). Máy chủ lọc theo tenant trong phiên; không có dữ liệu tenant khác.
 */
export default function Customers() {
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [source, setSource] = useState('')
  const [consent, setConsent] = useState('')
  const [page, setPage] = useState(1)
  const [state, setState] = useState<{ loading: boolean; data: CustomerPage | null; error: string | null }>({ loading: true, data: null, error: null })
  const [drawer, setDrawer] = useState<{ id: string; loading: boolean; data: CustomerDetail | null; error: string | null } | null>(null)

  useEffect(() => { const t = window.setTimeout(() => { setSearch(q.trim()); setPage(1) }, 300); return () => window.clearTimeout(t) }, [q])
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    try { setState({ loading: false, data: await api.customers({ q: search, source, consent, page, pageSize: PAGE_SIZE }), error: null }) }
    catch (e) { setState({ loading: false, data: null, error: e instanceof Error ? e.message : 'Lỗi' }) }
  }, [search, source, consent, page])
  useEffect(() => { void load() }, [load])

  const open = async (id: string) => {
    setDrawer({ id, loading: true, data: null, error: null })
    try { const data = await api.customer(id); setDrawer((d) => (d?.id === id ? { id, loading: false, data, error: null } : d)) }
    catch (e) { setDrawer((d) => (d?.id === id ? { id, loading: false, data: null, error: e instanceof Error ? e.message : 'Lỗi' } : d)) }
  }

  const d = state.data
  const summary = [
    { label: 'Tổng khách hàng', value: d?.stats.total, color: '#0F766E' },
    { label: 'Đồng ý nhận tin', value: d?.stats.granted, color: '#16A34A' },
    { label: 'Kết quả đang lọc', value: d?.total, color: '#B45309' },
    { label: 'Từ chối nhận tin', value: d?.stats.optedOut, color: '#DC2626' },
  ]
  const from = d && d.total ? (d.page - 1) * d.pageSize + 1 : 0
  const to = d ? Math.min(d.page * d.pageSize, d.total) : 0

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 p-4 sm:p-6 space-y-4 overflow-auto">
        <PageHeader crumb="Khách hàng" title="Khách hàng" description="Quản lý danh sách khách hàng và theo dõi lịch sử chăm sóc."
          actions={d ? <div className="flex items-center gap-2 text-[12px] text-[#6B7280]"><div className="w-2 h-2 rounded-full bg-[#0F766E]" /><span>{fmtNumber(d.stats.total)} khách hàng</span></div> : undefined} />

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {summary.map((s) => (
            <div key={s.label} className={cx(cardClass, 'p-3.5')}>
              {state.loading && !d ? <Skeleton className="h-5 w-10 mb-1" /> : <div className="text-[20px] font-bold leading-none mb-1" style={{ color: s.color }}>{s.value === undefined ? '—' : fmtNumber(s.value)}</div>}
              <div className="text-[11px] text-[#6B7280]">{s.label}</div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-[280px]">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9CA3AF]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm tên, số điện thoại đã che..." aria-label="Tìm khách hàng"
              className="w-full h-8 pl-8 pr-3 border border-[#E2E8F0] rounded-lg text-[12px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20 focus:border-[#0F766E]" />
          </div>
          <Select aria-label="Nguồn dữ liệu" value={source} onChange={(e) => { setSource(e.target.value); setPage(1) }}>
            <option value="">Tất cả nguồn</option>
            {SOURCE_FAMILIES.flatMap((f) => f.products).map((p) => <option key={p} value={p}>{productLabel(p)}</option>)}
          </Select>
          <Select aria-label="Đồng ý nhận tin" value={consent} onChange={(e) => { setConsent(e.target.value); setPage(1) }}>
            <option value="">Tất cả trạng thái đồng ý</option>
            <option value="GRANTED">Đồng ý</option><option value="WITHDRAWN">Từ chối</option><option value="UNKNOWN">Chưa rõ</option>
          </Select>
          <div className="ml-auto text-[12px] text-[#6B7280]">{d ? `${fmtNumber(d.total)} kết quả` : ''}</div>
        </div>

        <DataTable headers={['Khách hàng', 'Nguồn dữ liệu', 'Số lần chăm sóc', 'Đồng ý nhận tin', 'Tương tác cuối', '']} minWidth={760}
          footer={d && d.total > 0 ? <Pagination page={d.page} pageCount={Math.max(1, Math.ceil(d.total / d.pageSize))} total={d.total} from={from} to={to} unit="khách hàng" onPage={setPage} /> : undefined}>
          {state.error ? <tr><td colSpan={6}><ErrorState message={state.error} onRetry={() => void load()} /></td></tr>
            : state.loading && !d ? <tr><td colSpan={6}><TableSkeleton rows={6} cols={5} /></td></tr>
            : !d || d.items.length === 0 ? <tr><td colSpan={6}>{d && d.stats.total > 0
              ? <EmptyState icon={<Search size={18} />} title="Không có khách hàng phù hợp" description="Thử đổi từ khóa hoặc bộ lọc." />
              : <EmptyState icon={<Users size={18} />} title="Chưa có dữ liệu" description="Khách hàng sẽ xuất hiện khi nguồn dữ liệu PETCLINIC hoặc B2B SALE tạo lịch nhắc đầu tiên." />}</td></tr>
            : d.items.map((c) => {
              const cs = CONSENT[c.consentStatus]
              return (
                <tr key={c.id} onClick={() => void open(c.id)} className={cx(rowClass, 'cursor-pointer', drawer?.id === c.id && 'bg-[#F0FDFA]')}>
                  <td className={cellClass}>
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-[#F0FDFA] flex items-center justify-center text-[11px] font-semibold text-[#0F766E] shrink-0">{c.name.charAt(0)}</div>
                      <div><div className="text-[12px] font-medium text-[#172B2A]">{c.name}</div><div className="text-[10px] font-mono text-[#9CA3AF]">{c.maskedPhone || '—'}</div></div>
                    </div>
                  </td>
                  <td className={cellClass}><Badge tone={c.sourceProduct === 'B2B_SALE' ? 'blue' : 'brand'}>{productLabel(c.sourceProduct)}</Badge></td>
                  <td className={cx(cellClass, 'text-[12px] text-[#374151]')}>{fmtNumber(c.careCount)} lần</td>
                  <td className={cellClass}><span className={cx('text-[10px] font-medium', cs.tone === 'green' ? 'text-[#16A34A]' : cs.tone === 'red' ? 'text-[#DC2626]' : 'text-[#9CA3AF]')}>{cs.label}</span></td>
                  <td className={cx(cellClass, 'text-[11px] text-[#6B7280]')}>{fmtDate(c.lastInteractionAt)}</td>
                  <td className={cellClass}><button className="text-[11px] text-[#0F766E] hover:underline flex items-center gap-0.5">Chi tiết <ChevronRight size={11} /></button></td>
                </tr>
              )
            })}
        </DataTable>
      </div>

      {drawer && (
        <Drawer open title={drawer.data?.name || 'Khách hàng'} subtitle={drawer.data?.maskedPhone || undefined} onClose={() => setDrawer(null)}>
          {drawer.loading ? <div className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>
            : drawer.error ? <ErrorState message={drawer.error} onRetry={() => void open(drawer.id)} />
            : drawer.data && (
              <>
                <InfoList title="Thông tin khách hàng" rows={[
                  ['Số điện thoại', drawer.data.maskedPhone || '—'],
                  ['Nguồn dữ liệu', productLabel(drawer.data.sourceProduct)],
                  ['Đồng ý nhận tin', CONSENT[drawer.data.consentStatus].label],
                  ['Số lần chăm sóc', `${drawer.data.careCount} lần`],
                  ['Tương tác cuối', fmtDateTime(drawer.data.lastInteractionAt)],
                ]} />
                <div>
                  <SectionLabel>Lịch sử chăm sóc</SectionLabel>
                  {drawer.data.history.length === 0 ? <p className="text-[12px] text-[#9CA3AF]">Chưa có lịch sử.</p> : (
                    <div className="relative">
                      <div className="absolute left-[7px] top-0 bottom-0 w-px bg-[#E2E8F0]" />
                      <div className="space-y-3">
                        {drawer.data.history.map((h) => {
                          const s = JOB_STATUS[h.status]
                          const ok = h.status === 'SENT'; const bad = ['FAILED', 'ACCOUNT_RESTRICTED', 'RECIPIENT_NOT_FOUND'].includes(h.status)
                          return (
                            <div key={h.id} className="flex gap-3 pl-5 relative">
                              <div className={cx('absolute left-0 top-1 w-3.5 h-3.5 rounded-full border-2 border-white flex items-center justify-center text-white', ok ? 'bg-[#16A34A]' : bad ? 'bg-[#DC2626]' : 'bg-[#CBD5E1]')}>
                                {ok ? <CheckCircle2 size={8} /> : bad ? <AlertCircle size={8} /> : <Clock size={8} />}
                              </div>
                              <div className="pb-1 min-w-0">
                                <div className="text-[11px] font-mono text-[#9CA3AF]">{fmtDateTime(h.sentAt || h.scheduledAt)}</div>
                                <div className="text-[12px] font-medium text-[#172B2A]">{eventLabel(h.eventType)} <Badge tone={s.tone} className="ml-1">{s.label}</Badge></div>
                                <div className="text-[11px] text-[#6B7280] font-mono truncate">{h.externalReferenceId}</div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
        </Drawer>
      )}
    </div>
  )
}
