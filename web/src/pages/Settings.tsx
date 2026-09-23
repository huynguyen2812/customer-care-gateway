import { useEffect, useState } from 'react'
import { PauseCircle, PlayCircle, Moon, Clock, AlertTriangle, Zap, Save } from 'lucide-react'
import { Alert, Badge, Button, ConfirmDialog, EmptyState, ErrorState, PageHeader, Skeleton, Switch, cardClass, cx, useToast } from '@/components/ui'
import { api } from '@/lib/api'
import { AUTO_SEND_TEXT, autoSendState, useCrm } from '@/lib/data'
import { connectionName, zaloStatus } from '@/lib/format'

type Draft = Record<string, { dailyQuota: string; quietHoursStart: string; quietHoursEnd: string }>
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export default function Settings() {
  const crm = useCrm()
  const toast = useToast()
  const canManage = crm.can('crm.settings.manage')
  const s = crm.settings.data
  const state = autoSendState(s)
  const [confirm, setConfirm] = useState<null | 'pause' | 'resume'>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Draft>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [tenantQuota, setTenantQuota] = useState('')
  const [tenantQuotaError, setTenantQuotaError] = useState('')
  const [zaloBusy, setZaloBusy] = useState('')
  const canManageZalo = crm.can('crm.zalo.manage')

  useEffect(() => {
    if (!s) return
    setDraft(Object.fromEntries(s.installations.map((i) => [i.id, { dailyQuota: String(i.dailyQuota), quietHoursStart: i.quietHoursStart, quietHoursEnd: i.quietHoursEnd }])))
    setTenantQuota(s.tenantDailyQuota === null ? '' : String(s.tenantDailyQuota))
  }, [s])

  const toggleZalo = async (id: string, paused: boolean, name: string) => {
    setZaloBusy(id)
    try { await (paused ? api.resumeZaloAccount(id) : api.pauseZaloAccount(id)); toast('success', paused ? `Đã bật lại ${name}.` : `Đã tạm dừng ${name}.`); await crm.reload() }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Không thực hiện được.') } finally { setZaloBusy('') }
  }

  const apply = async () => {
    setBusy(true); setError('')
    try {
      await api.updateSettings({ autoSendPaused: confirm === 'pause' })
      toast('success', confirm === 'pause' ? 'Đã tạm dừng tự động gửi.' : 'Đã bật lại tự động gửi.')
      setConfirm(null)
      await crm.reload()
    } catch (e) { setError(e instanceof Error ? e.message : 'Không thực hiện được.') } finally { setBusy(false) }
  }

  const max = s?.entitlement.dailyQuotaMax ?? null
  const save = async () => {
    if (!s) return
    const errs: Record<string, string> = {}
    const changes = s.installations.flatMap((i) => {
      const dft = draft[i.id]; if (!dft) return []
      const q = Number(dft.dailyQuota)
      if (!Number.isInteger(q) || q < 1) errs[i.id] = 'Hạn mức phải là số nguyên dương.'
      else if (max !== null && q > max) errs[i.id] = `Hạn mức tối đa theo gói là ${max} tin/ngày.`
      else if (max === null && q > i.dailyQuota) errs[i.id] = 'Gói hiện tại chỉ cho phép giảm hạn mức.'
      else if (!HHMM.test(dft.quietHoursStart) || !HHMM.test(dft.quietHoursEnd)) errs[i.id] = 'Giờ yên tĩnh phải theo định dạng HH:MM.'
      else if (dft.quietHoursStart === dft.quietHoursEnd) errs[i.id] = 'Giờ bắt đầu và kết thúc phải khác nhau.'
      const changed = q !== i.dailyQuota || dft.quietHoursStart !== i.quietHoursStart || dft.quietHoursEnd !== i.quietHoursEnd
      return changed ? [{ id: i.id, dailyQuota: q, quietHoursStart: dft.quietHoursStart, quietHoursEnd: dft.quietHoursEnd }] : []
    })
    const tq = tenantQuota.trim() === '' ? null : Number(tenantQuota)
    let tqErr = ''
    if (tq !== null && (!Number.isInteger(tq) || tq < 1)) tqErr = 'Hạn mức phải là số nguyên dương.'
    else if (tq !== null && max !== null && tq > max) tqErr = `Tối đa theo gói là ${max} tin/ngày.`
    setTenantQuotaError(tqErr)
    const tenantChanged = !tqErr && tq !== s.tenantDailyQuota
    setErrors(errs); setSaveError('')
    if (Object.keys(errs).length || tqErr) return
    if (!changes.length && !tenantChanged) { toast('info', 'Không có thay đổi nào.'); return }
    setSaving(true)
    try { await api.updateSettings({ ...(changes.length ? { installations: changes } : {}), ...(tenantChanged ? { tenantDailyQuota: tq } : {}) }); toast('success', 'Đã lưu cài đặt.'); await crm.reload() }
    catch (e) { setSaveError(e instanceof Error ? e.message : 'Không lưu được cài đặt.') } finally { setSaving(false) }
  }

  const tone = state === 'active' ? 'green' : state === 'service_stopped' || state === 'entitlement' ? 'red' : 'amber'
  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[720px]">
      <PageHeader crumb="Cài đặt" title="Cài đặt" description="Kiểm soát tự động gửi tin và hạn mức của doanh nghiệp." />

      {crm.settings.error ? <div className={cardClass}><ErrorState message={crm.settings.error} onRetry={() => void crm.reload()} /></div> : <>
        <div className={cx('flex items-start gap-3 rounded-[10px] p-4 border', tone === 'green' ? 'bg-[#F0FDF4] border-[#BBF7D0]' : tone === 'red' ? 'bg-[#FEF2F2] border-[#FECACA]' : 'bg-[#FFFBEB] border-[#FDE68A]')}>
          <Zap size={16} className={cx('shrink-0 mt-0.5', tone === 'green' ? 'text-[#16A34A]' : tone === 'red' ? 'text-[#DC2626]' : 'text-[#D97706]')} />
          <div>
            <div className={cx('text-[12px] font-semibold', tone === 'green' ? 'text-[#16A34A]' : tone === 'red' ? 'text-[#DC2626]' : 'text-[#D97706]')}>{AUTO_SEND_TEXT[state].label}</div>
            <div className="text-[11px] text-[#6B7280] mt-0.5">
              {state === 'active' ? 'Tin nhắc lịch sẽ được gửi tự động theo cài đặt bên dưới.'
                : state === 'standby' ? 'Tự động gửi đang bật; tin được giữ trong hàng đợi cho tới khi dịch vụ gửi tin hoạt động.'
                : state === 'paused' ? 'Không có tin nhắn nào được gửi tự động cho đến khi bật lại. Các tin đang chờ vẫn được giữ.'
                : state === 'service_stopped' ? 'Đội hỗ trợ VETCLINIC CRM đang xử lý. Các tin đang chờ được giữ lại.'
                : state === 'entitlement' ? 'Gói VETCLINIC CRM không còn hiệu lực nên không gửi tin mới.'
                : 'Cần có kết nối dữ liệu trước khi bật tự động gửi.'}
            </div>
          </div>
        </div>

        <div className={cx(cardClass, 'p-5 space-y-4')}>
          <div className="flex items-center gap-3 mb-1"><Zap size={16} className="text-[#0F766E]" /><div className="text-[14px] font-semibold text-[#172B2A]">Tự động gửi tin nhắc lịch</div></div>
          <div className="flex items-center justify-between gap-4 py-2">
            <div>
              <div className="text-[13px] font-medium text-[#172B2A]">Bật / Tạm dừng tự động gửi</div>
              <div className="text-[11px] text-[#6B7280] mt-0.5">Áp dụng cho toàn bộ kết nối dữ liệu của doanh nghiệp bạn.</div>
            </div>
            {!s ? <Skeleton className="w-10 h-[22px] rounded-full" /> :
              <Switch checked={!s.autoSendPaused} disabled={!canManage || (s.autoSendPaused && !s.entitlement.usable)} label="Tự động gửi" onChange={(v) => { setError(''); setConfirm(v ? 'resume' : 'pause') }} />}
          </div>
          {!canManage && <p className="text-[11px] text-[#9CA3AF]">Bạn chỉ có quyền xem cài đặt.</p>}
          <div className="flex items-start gap-3 bg-[#F8FAFC] rounded-lg p-3">
            <AlertTriangle size={13} className="text-[#D97706] shrink-0 mt-0.5" />
            <p className="text-[11px] text-[#6B7280]">Để dừng khẩn cấp toàn bộ hệ thống hoặc điều chỉnh hạn mức gói dịch vụ, vui lòng liên hệ đội hỗ trợ VETCLINIC CRM.</p>
          </div>
        </div>

        <div className={cx(cardClass, 'p-5 space-y-4')}>
          <div className="flex items-center gap-3 mb-1"><Clock size={16} className="text-[#0F766E]" /><div className="text-[14px] font-semibold text-[#172B2A]">Hạn mức & lịch gửi</div></div>
          {s && <div className="border border-[#F1F5F9] rounded-lg p-4">
            <label htmlFor="tenant-quota" className="block text-[12px] font-medium text-[#374151] mb-1.5">Hạn mức chung của doanh nghiệp (mọi tài khoản Zalo cộng lại)</label>
            <div className="flex items-center gap-2 flex-wrap">
              <input id="tenant-quota" type="number" min={1} max={max ?? undefined} placeholder={max !== null ? String(max) : 'Không giới hạn chung'} value={tenantQuota} disabled={!canManage} onChange={(e) => setTenantQuota(e.target.value)} className="w-40 h-9 px-3 border border-[#E2E8F0] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20 focus:border-[#0F766E] disabled:bg-[#F8FAFC] disabled:text-[#6B7280]" />
              <span className="text-[12px] text-[#6B7280]">tin / ngày {max !== null ? `(gói cho phép tối đa ${max}; để trống = theo gói)` : '(để trống = chỉ áp hạn mức từng tài khoản)'}</span>
            </div>
            {tenantQuotaError && <p className="text-[11px] text-[#DC2626] mt-1">{tenantQuotaError}</p>}
          </div>}
          {!s ? <div className="space-y-3"><Skeleton className="h-9 w-40" /><Skeleton className="h-9 w-64" /></div>
            : s.installations.length === 0 ? <EmptyState title="Chưa có kết nối dữ liệu" description="Hạn mức và giờ yên tĩnh được áp dụng theo từng kết nối dữ liệu." />
            : s.installations.map((i) => {
              const dft = draft[i.id] || { dailyQuota: String(i.dailyQuota), quietHoursStart: i.quietHoursStart, quietHoursEnd: i.quietHoursEnd }
              const upd = (k: keyof typeof dft, v: string) => setDraft((x) => ({ ...x, [i.id]: { ...dft, [k]: v } }))
              return (
                <div key={i.id} className="border border-[#F1F5F9] rounded-lg p-4 space-y-3">
                  <div className="text-[12px] font-semibold text-[#172B2A]">{connectionName(i)}</div>
                  <div>
                    <label htmlFor={`q-${i.id}`} className="block text-[12px] font-medium text-[#374151] mb-1.5">Hạn mức gửi mỗi ngày</label>
                    <div className="flex items-center gap-2 flex-wrap">
                      <input id={`q-${i.id}`} type="number" min={1} max={max ?? i.dailyQuota} value={dft.dailyQuota} disabled={!canManage} onChange={(e) => upd('dailyQuota', e.target.value)} className="w-32 h-9 px-3 border border-[#E2E8F0] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20 focus:border-[#0F766E] disabled:bg-[#F8FAFC] disabled:text-[#6B7280]" />
                      <span className="text-[12px] text-[#6B7280]">tin / ngày {max !== null ? `(tối đa theo gói: ${max})` : '(gói hiện tại chỉ cho phép giảm)'}</span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-[#374151] mb-1.5"><Moon size={12} className="inline mr-1" />Giờ yên tĩnh (không gửi tin)</label>
                    <div className="flex items-center gap-2">
                      <input type="time" aria-label="Bắt đầu giờ yên tĩnh" value={dft.quietHoursStart} disabled={!canManage} onChange={(e) => upd('quietHoursStart', e.target.value)} className="h-9 px-3 border border-[#E2E8F0] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20 focus:border-[#0F766E] disabled:bg-[#F8FAFC] disabled:text-[#6B7280]" />
                      <span className="text-[#9CA3AF]">—</span>
                      <input type="time" aria-label="Kết thúc giờ yên tĩnh" value={dft.quietHoursEnd} disabled={!canManage} onChange={(e) => upd('quietHoursEnd', e.target.value)} className="h-9 px-3 border border-[#E2E8F0] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20 focus:border-[#0F766E] disabled:bg-[#F8FAFC] disabled:text-[#6B7280]" />
                    </div>
                    <p className="text-[11px] text-[#9CA3AF] mt-1">Trong khung giờ này, không có tin nhắn nào được gửi đến khách hàng.</p>
                  </div>
                  {errors[i.id] && <p className="text-[11px] text-[#DC2626]">{errors[i.id]}</p>}
                </div>
              )
            })}
          {saveError && <Alert kind="error">{saveError}</Alert>}
        </div>

        <div className={cx(cardClass, 'p-5 space-y-3')}>
          <div className="flex items-center gap-3 mb-1"><PauseCircle size={16} className="text-[#0F766E]" /><div className="text-[14px] font-semibold text-[#172B2A]">Tài khoản Zalo</div></div>
          {crm.zalo.error ? <p className="text-[12px] text-[#9CA3AF]">{crm.zalo.error}</p>
            : !crm.zalo.data ? <Skeleton className="h-9 w-full" />
            : crm.zalo.data.accounts.length === 0 ? <p className="text-[12px] text-[#9CA3AF]">Chưa có tài khoản Zalo nào. Thêm tài khoản tại trang Kênh Zalo.</p>
            : crm.zalo.data.accounts.map((a) => { const st = zaloStatus(a); return (
              <div key={a.id} className="flex items-center justify-between gap-3 py-2 border-b border-[#F8FAFC] last:border-0">
                <div className="min-w-0">
                  <div className="text-[13px] text-[#172B2A] truncate">{a.displayName}{a.isDefault ? ' · Mặc định' : ''}</div>
                  <div className="text-[11px] text-[#6B7280] flex items-center gap-1.5 flex-wrap"><Badge tone={st.tone}>{st.label}</Badge>Hạn mức {a.dailyQuota} tin/ngày</div>
                </div>
                {canManageZalo && <Button variant="secondary" size="sm" loading={zaloBusy === a.id} className={a.paused ? '' : '!text-[#D97706]'} onClick={() => void toggleZalo(a.id, a.paused, a.displayName)}>{a.paused ? 'Bật lại tài khoản' : 'Tạm dừng tài khoản'}</Button>}
              </div>
            ) })}
          <p className="text-[11px] text-[#9CA3AF]">Tạm dừng một tài khoản chỉ ngừng gửi qua tài khoản đó; tin đang chờ sẽ dùng tài khoản khác được phân công. Để dừng toàn bộ, dùng công tắc Tự động gửi ở trên.</p>
        </div>

        {canManage && s && s.installations.length > 0 && <Button icon={<Save size={14} />} loading={saving} onClick={() => void save()}>Lưu cài đặt</Button>}
      </>}

      <ConfirmDialog open={confirm !== null}
        title={confirm === 'resume' ? 'Bật lại tự động gửi' : 'Tạm dừng tự động gửi'}
        subtitle={confirm === 'resume' ? 'Tin nhắc lịch sẽ được gửi tự động trở lại' : 'Tin nhắc lịch sẽ không được gửi'}
        icon={confirm === 'resume' ? <PlayCircle size={18} /> : <PauseCircle size={18} />}
        confirmLabel={confirm === 'resume' ? 'Xác nhận bật lại' : 'Xác nhận tạm dừng'}
        loading={busy} error={error} onCancel={() => setConfirm(null)} onConfirm={() => void apply()}>
        {confirm === 'resume'
          ? 'Tự động gửi của doanh nghiệp bạn sẽ hoạt động lại theo giờ yên tĩnh và hạn mức hiện tại.'
          : 'Tính năng tự động gửi của doanh nghiệp bạn sẽ bị tạm dừng. Các tin đang chờ vẫn được giữ lại và sẽ tiếp tục khi bạn bật lại.'}
      </ConfirmDialog>
    </div>
  )
}
