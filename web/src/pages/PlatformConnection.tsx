import { useCallback, useEffect, useRef, useState } from 'react'
import { BadgeCheck, Info, LifeBuoy, Link2Off, RefreshCw, ShieldAlert } from 'lucide-react'
import { Alert, Badge, Button, ErrorState, Field, Input, PageHeader, Skeleton, cardClass, cx, useToast } from '@/components/ui'
import { api, ApiError } from '@/lib/api'
import { activationInputProps, normalizeActivationCodeInput, shouldClearCodeAfterError, shouldClearCodeForState } from '@/lib/activation-code'
import { useCrm } from '@/lib/data'
import { fmtDateTime } from '@/lib/format'
import type { BuildInfo, PlatformResetResponse, PlatformStatus } from '@/lib/types'

const REASON: Record<string, string> = {
  PLATFORM_UNPAIRED: 'Máy đã ngắt ghép nối với Platform — không gửi tin cho tới khi kích hoạt lại.',
  DEVICE_REVOKED: 'Platform đã thu hồi quyền của máy này — không gửi tin. Dữ liệu trên máy vẫn giữ nguyên.',
  DEVICE_REPAIR_REQUIRED: 'Máy này cần kích hoạt lại (ví dụ sau khi khôi phục dữ liệu sang máy khác).',
  PLAN_SUSPENDED: 'Gói dịch vụ đang tạm dừng — tin nhắn được giữ lại, chưa gửi.',
  PLAN_EXPIRED: 'Gói dịch vụ đã hết hạn — tin nhắn được giữ lại, chưa gửi.',
  PLAN_TERMINATED: 'Gói dịch vụ đã chấm dứt — không gửi tin mới.',
  PLAN_NOT_STARTED: 'Gói dịch vụ chưa đến ngày bắt đầu.',
  PLATFORM_CONFIG_MISSING: 'Chưa nhận được cấu hình từ Platform — bấm "Kiểm tra lại".',
  PLATFORM_ACTIVATION_REQUIRED: 'Máy đang chờ kích hoạt lại bằng mã mới từ Platform — chưa gửi tin.',
  PLATFORM_CONFIG_EXPIRED: 'Giấy phép ký từ Platform đã hết hạn (mất kết nối quá thời gian cho phép hoặc chưa được gia hạn) — tin nhắn được giữ lại, chưa gửi. Kiểm tra Internet rồi bấm "Kiểm tra lại".',
}
const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray'> = { ACTIVE: 'green', TRIAL: 'green', SUSPENDED: 'amber', EXPIRED: 'red', TERMINATED: 'red', REVOKED: 'red', UNPAIRED: 'gray', PENDING: 'gray' }
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Lỗi không xác định')
const CONFIRM_TEXT = 'NGAT GHEP NOI'
const ACTIVATION_ERROR: Record<string, string> = {
  PLATFORM_UNREACHABLE: 'không nhận được phản hồi từ Platform',
  ACTIVATION_FAILED: 'lỗi khi lưu cấu hình',
  ACTIVATION_CODE_INVALID: 'mã kích hoạt không đúng', ACTIVATION_CODE_EXPIRED: 'mã kích hoạt đã hết hạn', ACTIVATION_CODE_USED: 'mã đã được dùng cho máy khác',
  ACTIVATION_WRONG_PRODUCT: 'mã không dành cho VETCLINIC CRM', PLAN_NOT_ACTIVE: 'gói chưa hiệu lực',
}
const REASON_TEXT = (c: string | null) => (c ? ACTIVATION_ERROR[c] || (c.startsWith('CONFIG_') ? 'cấu hình Platform gửi về không hợp lệ' : `mã lỗi ${c}`) : 'chưa rõ nguyên nhân')
/** B — what Platform itself answered about the device record. Never inferred from the local reset (A). */
const PLATFORM_RESULT: Record<string, { kind: 'success' | 'info' | 'warning'; text: string }> = {
  PLATFORM_UNPAIRED: { kind: 'success', text: 'Platform đã xác nhận ngắt ghép thiết bị này.' },
  PLATFORM_ALREADY_REVOKED: { kind: 'success', text: 'Platform cho biết hồ sơ thiết bị cũ đã được thu hồi.' },
  PLATFORM_DEVICE_UNKNOWN: { kind: 'info', text: 'Platform không có hồ sơ của thiết bị này (lần kích hoạt trước chưa tới Platform) — không cần thu hồi.' },
  PLATFORM_NOT_CONFIRMED: { kind: 'warning', text: 'CHƯA xác nhận được trên Platform (mất kết nối hoặc Platform báo lỗi). Nếu Platform vẫn giữ thiết bị cũ, quản trị Platform phải thu hồi thiết bị đó trước khi cấp mã mới.' },
}

/**
 * Kết nối Platform (cấp phép). Trình duyệt chỉ gửi mã kích hoạt — không có ô tenantId, chi nhánh hay địa chỉ Platform.
 * Khác hoàn toàn "Khóa API của doanh nghiệp" (mục Tài khoản & kết nối): khóa đó vẫn do CRM trên máy tự sinh và quản lý.
 */
export default function PlatformConnection() {
  const { can } = useCrm()
  const toast = useToast()
  const [st, setSt] = useState<PlatformStatus | null>(null)
  const [build, setBuild] = useState<BuildInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Mã kích hoạt chỉ sống trong state của trang này (không lưu ở đâu khác); tải lại trang/rời trang ⇒ ô trống.
  const [code, setCode] = useState('')
  // Tên trường ngẫu nhiên mỗi lần mở trang: trình duyệt không gom được lịch sử tự điền theo tên trường.
  const [fieldName] = useState(() => `vc-activation-${Math.random().toString(36).slice(2, 10)}`)
  const [busy, setBusy] = useState<'' | 'activate' | 'sync' | 'unpair'>('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [reset, setReset] = useState<PlatformResetResponse['reset']>(null)
  const confirmRef = useRef<HTMLElement>(null)
  // On narrow screens the confirmation opens below the fold: bring it into view and focus the input.
  useEffect(() => { if (confirmOpen) { confirmRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); confirmRef.current?.querySelector('input')?.focus({ preventScroll: true }) } }, [confirmOpen])
  const load = useCallback(() => { api.platformStatus().then((s) => { setSt(s); setError(null) }, (e) => setError(errText(e))); api.version().then(setBuild, () => setBuild(null)) }, [])
  useEffect(load, [load])
  const canPair = can('crm.users.manage')

  const activate = async (e: React.FormEvent) => {
    e.preventDefault(); if (busy) return
    setBusy('activate'); setReset(null)
    try { setSt(await api.platformActivate(code)); setCode(''); toast('success', 'Đã kích hoạt với Platform.') }
    catch (err) {
      toast('error', errText(err))
      // Mã hết hạn/bị từ chối/thiết bị bị thu hồi ⇒ mã vô dụng: xóa khỏi ô. Mất phản hồi ⇒ giữ để thử lại đúng mã.
      if (err instanceof ApiError && shouldClearCodeAfterError(err.code)) setCode('')
      load() // show the pending/recovery state the server recorded
    }
    finally { setBusy('') }
  }
  const sync = async () => { setBusy('sync'); try { setSt(await api.platformSync()); toast('success', 'Đã kiểm tra lại với Platform.') } catch (err) { toast('error', errText(err)) } finally { setBusy('') } }
  const openConfirm = () => { setConfirmText(''); setConfirmOpen(true) }
  const cancelConfirm = () => { setConfirmOpen(false); setConfirmText('') } // nothing is sent
  const unpair = async () => {
    if (busy || confirmText.trim() !== CONFIRM_TEXT) return
    setBusy('unpair')
    try {
      const r = await api.platformUnpair(confirmText.trim())
      setSt(r); setReset(r.reset); setConfirmOpen(false); setConfirmText(''); setCode('') // the old code is useless now
      toast('success', 'Đã xóa trạng thái ghép nối trên máy này.')
    } catch (err) { toast('error', errText(err)); load() } finally { setBusy('') }
  }

  const reg = st?.device; const lic = st?.license; const act = st?.activation
  const paired = reg?.status === 'ACTIVE'
  const pending = reg?.status === 'PENDING'
  // Code form: fresh activation, a clearly-refused attempt, or retrying the SAME code of a possibly-bound attempt.
  const showCodeForm = !paired && (!pending || act?.state === 'NOT_BOUND' || act?.state === 'RETRY_SAME_CODE')
  const retrying = pending && act?.state === 'RETRY_SAME_CODE'
  const canRecover = canPair && (paired || (pending && act?.state !== 'IN_PROGRESS'))
  useEffect(() => { if (shouldClearCodeForState(reg?.status, act?.state)) setCode('') }, [reg?.status, act?.state])
  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[860px]">
      <PageHeader crumb="Kết nối Platform" title="Kết nối Platform" description="Platform VETCLINIC cấp gói, thời hạn, chi nhánh và hạn mức cho máy này. Dữ liệu khách, tin nhắn và phiên Zalo vẫn chỉ nằm trên máy." />
      {error ? <ErrorState message={error} onRetry={load} /> : !st ? <Skeleton className="h-40" /> : (
        <>
          {st.licenseBypass && <Alert kind="error" title="CHẾ ĐỘ KIỂM THỬ: đang bỏ qua giấy phép Platform">Máy đang chạy với cờ kiểm thử PLATFORM_LICENSE_BYPASS. Chỉ dùng trên máy thử, không bao giờ có trong bản phát hành.</Alert>}
          {st.mode === 'NOT_ACTIVATED' && <Alert kind="warning" title="Chưa kích hoạt — chưa gửi được tin">Máy cần mã kích hoạt do Platform cấp cho doanh nghiệp. Trong lúc chờ, vẫn đăng nhập, quản lý nhân viên, khóa API, cấu hình/xem trước nguồn dữ liệu và sao lưu bình thường; chỉ chưa tạo lịch nhắc và chưa gửi tin.</Alert>}
          {st.mode === 'MANAGED' && !st.allowed && st.reason && <Alert kind="error" title="Đang tạm dừng gửi tin">{REASON[st.reason] || st.reason}</Alert>}

          {reset && (
            <section className={cx(cardClass, 'p-4 space-y-2')} aria-live="polite" data-testid="reset-result">
              <div className="text-[13px] font-semibold text-[#172B2A]">Kết quả phục hồi</div>
              <Alert kind="success" title="Trên máy này">Đã xóa trạng thái ghép nối. Dữ liệu khách, nguồn, lịch sử, mẫu tin và khóa API cục bộ giữ nguyên. Gửi tin vẫn dừng cho tới khi kích hoạt bằng mã mới.</Alert>
              <Alert kind={PLATFORM_RESULT[reset.platform].kind} title="Trên Platform">{PLATFORM_RESULT[reset.platform].text}</Alert>
            </section>
          )}

          {pending && act && (
            act.state === 'IN_PROGRESS'
              ? <Alert kind="info" title="Đang kích hoạt">Một thao tác kích hoạt/phục hồi đang chạy. Đợi khoảng 1–2 phút rồi bấm "Tải lại".<div className="mt-2"><Button variant="outline" size="sm" onClick={load}>Tải lại</Button></div></Alert>
              : act.state === 'RECOVERY_REQUIRED'
                ? <Alert kind="error" title="Kích hoạt chưa hoàn tất — mã cũ không dùng được nữa">{act.lastError === 'DEVICE_REVOKED' ? 'Platform đã thu hồi thiết bị của lần kích hoạt này.' : 'Mã kích hoạt đã quá 10 phút kể từ khi Platform tạo mã.'} Máy chưa được kích hoạt và không gửi tin. Làm theo mục "Phục hồi kích hoạt" bên dưới.</Alert>
                : act.state === 'RETRY_SAME_CODE'
                  ? <Alert kind="warning" title="Kích hoạt chưa hoàn tất">Lần kích hoạt trước chưa hoàn tất ({REASON_TEXT(act.lastError)}). Máy <b>chưa</b> được kích hoạt và chưa gửi tin. Nhập lại <b>đúng mã vừa dùng</b> để hoàn tất — máy giữ nguyên thiết bị đang đăng ký, không tạo thiết bị mới. Mã chỉ dùng được trong 10 phút kể từ lúc quản trị Platform tạo mã; máy không lưu mã nên bạn cần nhập lại.</Alert>
                  : act.lastError ? <Alert kind="warning" title="Kích hoạt chưa thành công">{REASON_TEXT(act.lastError)} Có thể nhập mã khác.</Alert> : null
          )}

          {showCodeForm && (
            <section className={cx(cardClass, 'p-5')}>
              <div className="flex items-center gap-2 text-[14px] font-semibold text-[#172B2A]"><BadgeCheck size={15} className="text-[#0F766E]" />{retrying ? 'Thử lại kích hoạt (nhập lại đúng mã cũ)' : 'Kích hoạt bằng mã Platform'}</div>
              <p className="text-[12px] text-[#6B7280] mt-1 mb-4">Mã do quản trị viên Platform cấp cho doanh nghiệp, dùng một lần, hiệu lực 10 phút. Mã không phải mật khẩu đăng nhập và không phải khóa API.</p>
              {!st.platformConfigured && <Alert kind="info" className="mb-3">Bản cài này chưa có cấu hình Platform (địa chỉ/khóa ký). Cần bản cài mới từ VETCLINIC.</Alert>}
              {canPair ? (
                <form onSubmit={activate} autoComplete="off" className="flex flex-col sm:flex-row gap-3 sm:items-end">
                  <div className="flex-1"><Field label="Mã kích hoạt" htmlFor="activation-code"><Input id="activation-code" {...activationInputProps(fieldName)} placeholder="ABCD-EFGH-JKLM" value={code} onChange={(e) => setCode(normalizeActivationCodeInput(e.target.value))} className="font-mono tracking-wider" required /></Field></div>
                  <Button type="submit" loading={busy === 'activate'} disabled={!st.platformConfigured || !!busy}>{retrying ? 'Thử lại' : 'Kích hoạt'}</Button>
                </form>
              ) : <p className="text-[12px] text-[#6B7280]">Chỉ chủ doanh nghiệp được kích hoạt.</p>}
            </section>
          )}

          {paired && reg && lic && (
            <section className={cx(cardClass, 'p-5')}>
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <div className="text-[14px] font-semibold text-[#172B2A] flex-1 min-w-0 truncate">{lic.businessName}</div>
                <Badge tone={STATUS_TONE[lic.planStatus] || 'gray'}>Gói {lic.planCode}: {lic.planStatus}</Badge>
                <Badge tone={STATUS_TONE[reg.status] || 'gray'}>Thiết bị: {reg.status}</Badge>
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
                {([
                  ['Thời hạn gói', lic.validUntil ? fmtDateTime(lic.validUntil) : 'Không thời hạn'],
                  ['Mã thiết bị', reg.deviceIdMasked],
                  ['Xác thực gần nhất', fmtDateTime(reg.lastValidatedAt)],
                  ['Được gửi tin đến', reg.licensedUntil ? `${fmtDateTime(reg.licensedUntil)} (còn ${reg.offlineRemainingHours ?? 0} giờ)` : '—'],
                  ['Cấu hình Platform hết hạn', reg.configExpiresAt ? fmtDateTime(reg.configExpiresAt) : '—'],
                  ['Hạn mức gửi/ngày', String(lic.dailyQuota)],
                  ['Nhắc trước lịch hẹn', `${lic.reminderLeadMinutes} phút`],
                  ['Giờ yên tĩnh', `${lic.quietHours.start}–${lic.quietHours.end}`],
                  ['Tính năng', [lic.features.appointmentReminder && 'Nhắc lịch hẹn', lic.features.debtReminder && 'Nhắc công nợ'].filter(Boolean).join(', ') || 'Không'],
                  ['Phiên bản cấu hình', `#${reg.configRevision}`],
                  ['Lỗi đồng bộ gần nhất', reg.lastSyncError || 'Không'],
                ] as const).map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b border-[#F1F5F9] py-1.5"><dt className="text-[#6B7280]">{k}</dt><dd className="text-[#172B2A] text-right font-medium">{v}</dd></div>)}
              </dl>
              <div className="mt-4">
                <div className="text-[12px] font-medium text-[#374151] mb-1.5">Nguồn và chi nhánh được cấp</div>
                {lic.sources.length === 0 ? <p className="text-[12px] text-[#6B7280]">Chưa có chi nhánh nào được cấp.</p> : lic.sources.map((s) => (
                  <div key={s.product} className="flex flex-wrap items-center gap-1.5 mb-1"><Badge tone="brand">{s.product}</Badge>{s.allowedBranchIds.map((b) => <Badge key={b} tone="gray">{b}</Badge>)}</div>
                ))}
                <p className="flex items-start gap-1.5 text-[11px] text-[#9CA3AF] mt-2"><Info size={12} className="shrink-0 mt-0.5" />Mỗi nguồn có danh sách chi nhánh riêng. Trong mục Tài khoản &amp; kết nối, bạn chỉ chọn được chi nhánh Platform cấp cho đúng loại nguồn đã chọn.</p>
              </div>
              <div className="flex flex-wrap gap-2 mt-5">
                {can('crm.settings.manage') && <Button variant="outline" icon={<RefreshCw size={14} />} loading={busy === 'sync'} onClick={() => void sync()}>Kiểm tra lại</Button>}
                {canPair && reg.status === 'ACTIVE' && <Button variant="danger" icon={<Link2Off size={14} />} disabled={!!busy} onClick={openConfirm}>Ngắt ghép nối…</Button>}
              </div>
            </section>
          )}

          {pending && act && act.state !== 'IN_PROGRESS' && (
            <section className={cx(cardClass, 'p-5')} data-testid="recovery">
              <div className="flex items-center gap-2 text-[14px] font-semibold text-[#172B2A]"><LifeBuoy size={15} className="text-[#0F766E]" />Phục hồi kích hoạt</div>
              <p className="text-[12px] text-[#6B7280] mt-1">Dùng khi mã cũ đã hết hạn hoặc không thể hoàn tất kích hoạt. Không xóa khách hàng, nguồn dữ liệu, lịch sử, mẫu tin hay khóa API cục bộ.</p>
              <ol className="list-decimal pl-5 mt-3 space-y-1.5 text-[12px] text-[#374151]">
                <li><b>Quản trị Platform</b> (không làm được trên máy này): mở Platform Admin → doanh nghiệp → VETCLINIC CRM → thiết bị PC. Nếu còn thiết bị có mã <span className="font-mono">{reg?.deviceIdMasked}</span>, bấm <b>Thu hồi</b>. Không thu hồi nhầm PC đang dùng.</li>
                <li><b>Tại máy này</b> (chủ doanh nghiệp): bấm "Xóa trạng thái ghép nối trên máy này" và xác nhận.</li>
                <li>Quản trị Platform <b>tạo mã mới</b>; nhập mã mới ở đây. Máy sẽ dùng mã thiết bị và khóa mới.</li>
              </ol>
              {canRecover
                ? <div className="mt-4"><Button variant="danger" icon={<Link2Off size={14} />} disabled={!!busy} onClick={openConfirm}>Xóa trạng thái ghép nối trên máy này…</Button></div>
                : <p className="text-[12px] text-[#6B7280] mt-3">Chỉ chủ doanh nghiệp được phục hồi kích hoạt.</p>}
            </section>
          )}

          {confirmOpen && canRecover && (
            <section ref={confirmRef} role="dialog" aria-modal="false" aria-labelledby="confirm-reset-title" className={cx(cardClass, 'p-5 border-[#FCA5A5]')} data-testid="confirm-reset">
              <div id="confirm-reset-title" className="text-[14px] font-semibold text-[#991B1B]">{paired ? 'Ngắt ghép nối với Platform' : 'Xóa trạng thái ghép nối trên máy này'}</div>
              <ul className="list-disc pl-5 mt-2 space-y-1 text-[12px] text-[#374151]">
                <li>Máy này sẽ <b>dừng gửi tin tự động</b> cho tới khi kích hoạt lại bằng mã mới (mã thiết bị mới).</li>
                <li>Không xóa khách hàng, nguồn dữ liệu, lịch sử, mẫu tin, phiên Zalo hay khóa API cục bộ.</li>
                <li>Máy sẽ báo Platform nếu kết nối được. <b>Việc xóa trên máy này không có nghĩa Platform đã thu hồi thiết bị</b> — kết quả phía Platform được hiển thị riêng.</li>
              </ul>
              <div className="mt-3 max-w-[360px]"><Field label={`Gõ ${CONFIRM_TEXT} để xác nhận`} htmlFor="confirm-reset-input"><Input id="confirm-reset-input" autoComplete="off" spellCheck={false} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} /></Field></div>
              <div className="flex flex-wrap gap-2 mt-4">
                <Button variant="danger" loading={busy === 'unpair'} disabled={confirmText.trim() !== CONFIRM_TEXT || (!!busy && busy !== 'unpair')} onClick={() => void unpair()}>Xác nhận</Button>
                <Button variant="outline" disabled={busy === 'unpair'} onClick={cancelConfirm}>Hủy</Button>
              </div>
            </section>
          )}

          <section className={cx(cardClass, 'p-4')}>
            <div className="flex items-center gap-2 text-[12px] text-[#6B7280]"><ShieldAlert size={13} className="text-[#0F766E]" />Phiên bản: <b className="text-[#172B2A]">{build?.version || '—'}</b>
              {build?.crmCommit && <span className="font-mono">CRM {build.crmCommit.slice(0, 7)} · Sender {build.senderCommit?.slice(0, 7)}</span>}
              {build?.dirty && <Badge tone="amber">Bản thử (mã nguồn chưa commit)</Badge>}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
