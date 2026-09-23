import { useCallback, useEffect, useState } from 'react'
import {
  Calendar, MessageSquare, CheckCircle2, XCircle, UserX, TrendingUp, RefreshCw, ChevronRight,
  PauseCircle, PlayCircle, AlertTriangle, Minus,
} from 'lucide-react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { Alert, Badge, ConfirmDialog, EmptyState, ErrorState, KpiCard, PageHeader, Skeleton, Tabs, cardClass, cx, useToast } from '@/components/ui'
import { AUTO_SEND_TEXT, autoSendState, useCrm } from '@/lib/data'
import { api } from '@/lib/api'
import { JOB_STATUS, actionLabel, eventLabel, fmtNumber, fmtTime, fmtDateTime } from '@/lib/format'
import { navigate } from '@/routes'
import type { Overview } from '@/lib/types'

type Period = 'today' | '7d' | '30d'
const WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

export default function Dashboard() {
  const crm = useCrm()
  const toast = useToast()
  const [period, setPeriod] = useState<Period>('7d')
  const [ov, setOv] = useState<{ loading: boolean; data: Overview | null; error: string | null }>({ loading: true, data: null, error: null })
  const [confirmPause, setConfirmPause] = useState<null | 'pause' | 'resume'>(null)
  const [pausing, setPausing] = useState(false)
  const [pauseError, setPauseError] = useState('')

  const load = useCallback(async (p: Period) => {
    setOv((s) => ({ ...s, loading: true }))
    try { setOv({ loading: false, data: await api.overview(p), error: null }) } catch (e) { setOv({ loading: false, data: null, error: e instanceof Error ? e.message : 'Lỗi' }) }
  }, [])
  useEffect(() => { void load(period) }, [load, period])

  const state = autoSendState(crm.settings.data)
  const o = ov.data
  const canPause = crm.can('crm.settings.manage')
  const series = (o?.series || []).map((b) => { const d = new Date(b.date); return { ...b, day: o && o.series.length <= 7 ? WEEKDAY[d.getDay()] : `${d.getDate()}/${d.getMonth() + 1}` } })
  const successRate = o && o.counts.sent + o.counts.failed > 0 ? `${((o.counts.sent / (o.counts.sent + o.counts.failed)) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%` : '—'
  const pie = o ? [
    { name: 'Đã gửi', value: o.counts.sent, color: '#0F766E' },
    { name: 'Thất bại', value: o.counts.failed, color: '#DC2626' },
    { name: 'Đang chờ', value: o.counts.queued + o.counts.processing, color: '#D97706' },
  ] : []
  const pieTotal = pie.reduce((s, x) => s + x.value, 0)
  const installations = crm.installations.data || []
  const liveConnections = installations.filter((i) => i.status === 'ACTIVE')

  const kpis = [
    { label: 'Lịch hẹn sắp tới', value: o ? fmtNumber(o.counts.upcoming) : '—', icon: <Calendar size={16} />, color: '#0F766E', bg: '#F0FDFA' },
    { label: 'Tin đang chờ gửi', value: o ? fmtNumber(o.counts.queued) : '—', icon: <MessageSquare size={16} />, color: '#D97706', bg: '#FFFBEB' },
    { label: 'Đã gửi thành công', value: o ? fmtNumber(o.counts.sent) : '—', icon: <CheckCircle2 size={16} />, color: '#16A34A', bg: '#F0FDF4' },
    { label: 'Gửi thất bại', value: o ? fmtNumber(o.counts.failed) : '—', icon: <XCircle size={16} />, color: '#DC2626', bg: '#FEF2F2' },
    { label: 'Từ chối nhận tin', value: o ? fmtNumber(o.counts.optedOut) : '—', icon: <UserX size={16} />, color: '#6B7280', bg: '#F9FAFB' },
    { label: 'Tỷ lệ thành công', value: successRate, icon: <TrendingUp size={16} />, color: '#0F766E', bg: '#F0FDFA' },
  ]

  const doPause = async () => {
    setPausing(true); setPauseError('')
    try {
      await api.updateSettings({ autoSendPaused: confirmPause === 'pause' })
      toast('success', confirmPause === 'pause' ? 'Đã tạm dừng tự động gửi.' : 'Đã bật lại tự động gửi.')
      setConfirmPause(null)
      await Promise.all([crm.reload(), load(period)])
    } catch (e) { setPauseError(e instanceof Error ? e.message : 'Không thực hiện được.') } finally { setPausing(false) }
  }

  const paused = state === 'paused'
  const toggleable = canPause && (state === 'active' || state === 'standby' || state === 'paused')
  const good = state === 'active'

  return (
    <div className="p-4 sm:p-6 space-y-5 min-h-full">
      <PageHeader
        crumb="Tổng quan"
        title="Tổng quan chăm sóc khách hàng"
        description="Theo dõi hiệu quả chăm sóc và lịch sử gửi tin nhắc lịch."
        actions={<>
          <Tabs label="Khoảng thời gian" value={period} onChange={setPeriod} options={[{ value: 'today', label: 'Hôm nay' }, { value: '7d', label: '7 ngày' }, { value: '30d', label: '30 ngày' }]} />
          <button
            onClick={() => setConfirmPause(paused ? 'resume' : 'pause')}
            disabled={!toggleable}
            title={canPause ? undefined : 'Bạn không có quyền thay đổi cài đặt gửi'}
            className={cx('flex items-center gap-1.5 px-3 py-2 border text-[12px] font-medium rounded-lg transition-colors disabled:cursor-not-allowed',
              good ? 'bg-[#F0FDF4] border-[#BBF7D0] text-[#16A34A] hover:bg-[#DCFCE7]' : 'bg-[#F9FAFB] border-[#E2E8F0] text-[#6B7280] hover:bg-[#F1F5F9]')}
          >
            {good ? <PlayCircle size={13} /> : <PauseCircle size={13} />}{AUTO_SEND_TEXT[state].label}
          </button>
        </>}
      />

      {state === 'service_stopped' && <Alert kind="error" title="Dịch vụ gửi tin đang tạm ngưng">Mọi tin nhắc lịch đang được giữ lại. Đội hỗ trợ VETCLINIC CRM sẽ khôi phục dịch vụ; bạn không cần thao tác gì thêm.</Alert>}
      {state === 'standby' && <Alert kind="warning" title="Tự động gửi đang bật nhưng dịch vụ gửi chưa chạy">Tin nhắc lịch được giữ trong hàng đợi và sẽ gửi khi dịch vụ gửi tin được bật.</Alert>}
      {ov.error && <Alert kind="error" title="Không tải được số liệu tổng quan" action={<button onClick={() => void load(period)} className="text-[11px] text-[#DC2626] hover:underline shrink-0">Thử lại</button>}>{ov.error}</Alert>}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 xl:grid-cols-6">
        {kpis.map((k) => ov.loading && !o ? <div key={k.label} className={cx(cardClass, 'p-4 space-y-3')}><Skeleton className="w-8 h-8" /><Skeleton className="h-5 w-16" /><Skeleton className="h-3 w-24" /></div> : <KpiCard key={k.label} {...k} />)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className={cx(cardClass, 'lg:col-span-2 p-4')}>
          <div className="flex items-center justify-between mb-4 gap-3">
            <div>
              <div className="text-[13px] font-semibold text-[#172B2A]">Lượng tin gửi theo ngày</div>
              <div className="text-[11px] text-[#6B7280]">{period === 'today' ? 'Hôm nay' : period === '7d' ? '7 ngày gần nhất' : '30 ngày gần nhất'}</div>
            </div>
            <div className="flex items-center gap-3 text-[11px] shrink-0">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-[#0F766E] inline-block" />Đã gửi</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-[#FCA5A5] inline-block" />Thất bại</span>
            </div>
          </div>
          {ov.loading && !o ? <Skeleton className="h-[180px] w-full" /> : ov.error ? <ErrorState message={ov.error} onRetry={() => void load(period)} /> : (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={series} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="crm-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0F766E" stopOpacity={0.15} />
                    <stop offset="100%" stopColor="#0F766E" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E2E8F0' }} />
                <Area type="monotone" dataKey="sent" name="Đã gửi" stroke="#0F766E" strokeWidth={2} fill="url(#crm-grad)" dot={false} />
                <Area type="monotone" dataKey="failed" name="Thất bại" stroke="#FCA5A5" strokeWidth={1.5} fill="none" dot={false} strokeDasharray="3 3" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className={cx(cardClass, 'p-4')}>
          <div className="text-[13px] font-semibold text-[#172B2A] mb-1">Phân bố trạng thái</div>
          <div className="text-[11px] text-[#6B7280] mb-3">Tổng {fmtNumber(pieTotal)} tác vụ chăm sóc</div>
          {ov.loading && !o ? <Skeleton className="h-[130px] w-full" /> : pieTotal === 0 ? (
            <EmptyState title="Chưa có tác vụ chăm sóc" description="Số liệu sẽ xuất hiện khi có lịch nhắc đầu tiên." />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={130}>
                <PieChart>
                  <Pie data={pie} cx="50%" cy="50%" innerRadius={38} outerRadius={58} paddingAngle={2} dataKey="value">
                    {pie.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-1.5 mt-2">
                {pie.map((d) => (
                  <div key={d.name} className="flex items-center justify-between text-[11px]">
                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} /><span className="text-[#6B7280]">{d.name}</span></span>
                    <span className="font-semibold text-[#172B2A]">{fmtNumber(d.value)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className={cardClass}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#F1F5F9]">
            <div className="text-[13px] font-semibold text-[#172B2A]">Lịch nhắc sắp gửi</div>
            {crm.can('crm.jobs.read') && <button onClick={() => navigate('hang-doi')} className="text-[11px] text-[#0F766E] hover:underline flex items-center gap-0.5">Xem tất cả <ChevronRight size={12} /></button>}
          </div>
          {ov.loading && !o ? <div className="p-4 space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
            : !o?.upcoming.length ? <EmptyState icon={<Calendar size={18} />} title="Không có lịch nhắc đang chờ" description="Các lịch nhắc mới từ nguồn dữ liệu sẽ xuất hiện tại đây." />
            : o.upcoming.map((r) => {
              const s = JOB_STATUS[r.status]
              return (
                <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#F8FAFC] transition-colors border-b border-[#F8FAFC] last:border-0">
                  <div className="w-8 h-8 rounded-lg bg-[#F0FDFA] flex items-center justify-center text-[#0F766E] shrink-0"><Calendar size={14} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-[#172B2A] truncate">{eventLabel(r.eventType)}</div>
                    <div className="text-[11px] text-[#6B7280] truncate font-mono">{r.externalReferenceId}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[11px] text-[#374151]">{fmtDateTime(r.scheduledAt)}</div>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </div>
                </div>
              )
            })}
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className={cx(cardClass, 'p-3')}>
              <div className="text-[12px] font-medium text-[#172B2A] mb-2">Kết nối dữ liệu</div>
              {crm.installations.error ? <div className="text-[11px] text-[#9CA3AF]">{crm.installations.error}</div> : (
                <>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <div className={cx('w-2 h-2 rounded-full', liveConnections.length ? 'bg-[#16A34A]' : 'bg-[#9CA3AF]')} />
                    <span className={cx('text-[11px] font-medium', liveConnections.length ? 'text-[#16A34A]' : 'text-[#9CA3AF]')}>{liveConnections.length}/{installations.length} kết nối</span>
                  </div>
                  <button onClick={() => navigate('nguon-du-lieu')} className="text-[10px] text-[#6B7280] hover:text-[#0F766E]">PETCLINIC · B2B SALE</button>
                </>
              )}
            </div>
            <div className={cx(cardClass, 'p-3')}>
              <div className="text-[12px] font-medium text-[#172B2A] mb-2">Tự động gửi</div>
              <div className="flex items-center gap-1.5 mb-0.5">
                <div className={cx('w-2 h-2 rounded-full', good ? 'bg-[#16A34A]' : state === 'service_stopped' || state === 'entitlement' ? 'bg-[#DC2626]' : state === 'paused' || state === 'standby' ? 'bg-[#D97706]' : 'bg-[#9CA3AF]')} />
                <span className={cx('text-[11px] font-medium', good ? 'text-[#16A34A]' : state === 'service_stopped' || state === 'entitlement' ? 'text-[#DC2626]' : state === 'paused' || state === 'standby' ? 'text-[#D97706]' : 'text-[#9CA3AF]')}>{AUTO_SEND_TEXT[state].short}</span>
              </div>
              {toggleable && <button onClick={() => setConfirmPause(paused ? 'resume' : 'pause')} className={cx('text-[10px] font-medium hover:underline', paused ? 'text-[#0F766E]' : 'text-[#D97706]')}>{paused ? 'Bật lại' : 'Tạm dừng'}</button>}
            </div>
          </div>

          <div className={cardClass}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#F1F5F9]">
              <div className="text-[13px] font-semibold text-[#172B2A]">Hoạt động gần đây</div>
              <button aria-label="Làm mới" onClick={() => void load(period)} className="text-[#9CA3AF] hover:text-[#6B7280]"><RefreshCw size={13} className={ov.loading ? 'animate-spin' : ''} /></button>
            </div>
            {ov.loading && !o ? <div className="p-4 space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-4 w-full" />)}</div>
              : !o?.recent.length ? <EmptyState title="Chưa có hoạt động" />
              : o.recent.map((l) => (
                <div key={l.id} className="flex items-center gap-3 px-4 py-2 hover:bg-[#F8FAFC]">
                  <span className="text-[11px] text-[#9CA3AF] font-mono w-10 shrink-0">{fmtTime(l.createdAt)}</span>
                  <div className="flex-1 min-w-0 truncate"><span className="text-[11px] text-[#172B2A]">{actionLabel(l.action)}</span></div>
                  {l.result === 'SUCCESS' ? <CheckCircle2 size={12} className="text-[#16A34A] shrink-0" aria-label="Thành công" />
                    : l.result === 'NO_CHANGE' ? <Minus size={12} className="text-[#9CA3AF] shrink-0" aria-label="Không thay đổi" />
                    : <XCircle size={12} className="text-[#DC2626] shrink-0" aria-label="Thất bại" />}
                </div>
              ))}
          </div>
        </div>
      </div>

      {state === 'no_connection' && !crm.loading && (
        <Alert kind="warning" title="Chưa có kết nối dữ liệu" action={<button onClick={() => navigate('nguon-du-lieu')} className="text-[11px] text-[#B45309] hover:underline shrink-0 flex items-center gap-1"><AlertTriangle size={11} />Xem nguồn dữ liệu</button>}>
          Doanh nghiệp chưa có kết nối PETCLINIC hoặc B2B SALE nên chưa thể tạo lịch nhắc.
        </Alert>
      )}

      <ConfirmDialog
        open={confirmPause !== null}
        title={confirmPause === 'resume' ? 'Bật lại tự động gửi' : 'Tạm dừng tự động gửi'}
        subtitle={confirmPause === 'resume' ? 'Tin nhắc lịch sẽ được gửi tự động trở lại' : 'Tin nhắc lịch sẽ không được gửi tự động'}
        icon={confirmPause === 'resume' ? <PlayCircle size={20} /> : <PauseCircle size={20} />}
        confirmLabel={confirmPause === 'resume' ? 'Xác nhận bật lại' : 'Xác nhận tạm dừng'}
        loading={pausing}
        error={pauseError}
        onCancel={() => { setConfirmPause(null); setPauseError('') }}
        onConfirm={() => void doPause()}
      >
        {confirmPause === 'resume'
          ? 'Tự động gửi tin nhắc lịch của doanh nghiệp bạn sẽ hoạt động lại theo giờ yên tĩnh và hạn mức hiện tại.'
          : 'Tính năng tự động gửi tin nhắc lịch của doanh nghiệp bạn sẽ bị tạm dừng. Các tin đang chờ vẫn được giữ và sẽ tiếp tục khi bật lại.'}
      </ConfirmDialog>
    </div>
  )
}
