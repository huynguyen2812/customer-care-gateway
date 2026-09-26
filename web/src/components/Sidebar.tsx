import { useEffect, useState } from 'react'
import {
  LayoutDashboard, Users, Database, MessageCircle, FileText, Clock,
  UserX, ScrollText, Settings, ChevronLeft, ChevronRight, CheckCircle2, PawPrint, X,
  PauseCircle, AlertTriangle, Loader2, KeyRound, BadgeCheck,
} from 'lucide-react'
import { cx } from './ui'
import { AUTO_SEND_TEXT, autoSendState, useCrm, zaloSummary } from '@/lib/data'
import { initials } from '@/lib/format'
import type { Route } from '@/routes'
import type { Permission } from '@/lib/types'

export const NAV: { id: Route; label: string; icon: typeof LayoutDashboard; permission: Permission; standaloneOnly?: boolean }[] = [
  { id: 'tong-quan', label: 'Tổng quan', icon: LayoutDashboard, permission: 'crm.dashboard.read' },
  { id: 'khach-hang', label: 'Khách hàng', icon: Users, permission: 'crm.customers.read' },
  { id: 'nguon-du-lieu', label: 'Nguồn dữ liệu', icon: Database, permission: 'crm.sources.read' },
  { id: 'kenh-zalo', label: 'Kênh Zalo', icon: MessageCircle, permission: 'crm.zalo.read' },
  { id: 'mau-tin-nhan', label: 'Mẫu tin nhắn', icon: FileText, permission: 'crm.templates.read' },
  { id: 'hang-doi', label: 'Hàng đợi & lịch sử', icon: Clock, permission: 'crm.jobs.read' },
  { id: 'tu-choi-nhan-tin', label: 'Từ chối nhận tin', icon: UserX, permission: 'crm.optouts.read' },
  { id: 'nhat-ky', label: 'Nhật ký', icon: ScrollText, permission: 'crm.audit.read' },
  { id: 'cai-dat', label: 'Cài đặt', icon: Settings, permission: 'crm.settings.read' },
  { id: 'tai-khoan-ket-noi', label: 'Tài khoản & kết nối', icon: KeyRound, permission: 'crm.sources.read', standaloneOnly: true },
  { id: 'ket-noi-platform', label: 'Kết nối Platform', icon: BadgeCheck, permission: 'crm.settings.read', standaloneOnly: true },
]

const COLLAPSE_KEY = 'vetclinic-crm:sidebar-collapsed'
function readCollapsed(): boolean {
  try { return window.localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
}

export default function Sidebar({ current, onNavigate, mobileOpen, onCloseMobile }: {
  current: Route; onNavigate: (r: Route) => void; mobileOpen: boolean; onCloseMobile: () => void
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  useEffect(() => { try { window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0') } catch { /* bỏ qua */ } }, [collapsed])
  const crm = useCrm()
  const username = crm.me.user.displayName || crm.me.user.username || 'Người dùng'
  const roleLabel = ({ CRM_OWNER: 'Chủ doanh nghiệp', CRM_ADMIN: 'Quản trị viên', CRM_STAFF: 'Nhân viên', CRM_VIEWER: 'Người xem' } as Record<string, string>)[crm.me.roles[0]] || 'Người dùng'
  const state = autoSendState(crm.settings.data)
  const zalo = zaloSummary(crm.zalo.data)
  const zaloText = { all: `Zalo: ${zalo.usable}/${zalo.total} tài khoản hoạt động`, partial: `Zalo: ${zalo.usable}/${zalo.total} tài khoản hoạt động`, relogin: `Zalo: có tài khoản cần đăng nhập lại (${zalo.usable}/${zalo.total})`, down: 'Zalo: chưa có tài khoản sẵn sàng', none: 'Chưa có tài khoản Zalo', unknown: 'Đang kiểm tra Zalo' }[zalo.state]
  const zaloDot = zalo.state === 'all' ? 'bg-[#16A34A]' : zalo.state === 'partial' || zalo.state === 'relogin' ? 'bg-[#D97706]' : zalo.state === 'down' ? 'bg-[#DC2626]' : 'bg-[#9CA3AF]'

  const go = (r: Route) => { onNavigate(r); onCloseMobile() }
  // Trên tablet (md–lg) sidebar luôn thu gọn để bảng có đủ chiều ngang; mobile dùng ngăn kéo.
  const compact = collapsed

  const body = (isMobile: boolean) => {
    const narrow = !isMobile && compact
    return (
      <aside
        style={isMobile ? undefined : { transition: 'width 0.2s ease' }}
        className={cx('flex flex-col bg-white border-r border-[#E2E8F0] h-full shrink-0', isMobile ? 'w-[260px]' : narrow ? 'w-[60px]' : 'w-[60px] lg:w-[240px]')}
      >
        <div className="flex items-center gap-3 px-4 py-5 border-b border-[#E2E8F0] overflow-hidden">
          <div className="w-8 h-8 rounded-lg bg-[#0F766E] flex items-center justify-center shrink-0">
            <PawPrint size={16} color="white" aria-hidden />
          </div>
          <div className={cx('min-w-0 flex-1', !isMobile && (narrow ? 'hidden' : 'hidden lg:block'))}>
            <div className="text-[13px] font-bold text-[#172B2A] leading-tight truncate">VETCLINIC CRM</div>
            <div className="text-[10px] text-[#6B7280] leading-tight truncate">Chăm sóc khách hàng</div>
          </div>
          {isMobile && <button aria-label="Đóng menu" onClick={onCloseMobile} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[#F1F5F9] text-[#6B7280]"><X size={14} /></button>}
        </div>

        <nav aria-label="Điều hướng chính" className="flex-1 py-3 overflow-y-auto">
          {NAV.filter((n) => crm.can(n.permission) && (!n.standaloneOnly || crm.me.mode === 'standalone')).map(({ id, label, icon: Icon }) => {
            const active = current === id
            return (
              <button
                key={id}
                onClick={() => go(id)}
                title={label}
                aria-current={active ? 'page' : undefined}
                className={cx('w-full flex items-center gap-3 px-4 py-2.5 text-[13px] font-medium transition-colors text-left',
                  active ? 'bg-[#F0FDFA] text-[#0F766E]' : 'text-[#374151] hover:bg-[#F8FAFC] hover:text-[#172B2A]')}
              >
                <Icon size={16} className="shrink-0" aria-hidden />
                <span className={cx('truncate', !isMobile && (narrow ? 'sr-only' : 'sr-only lg:not-sr-only'))}>{label}</span>
              </button>
            )
          })}
        </nav>

        <div className={cx('px-4 py-3 border-t border-[#E2E8F0]', !isMobile && (narrow ? 'hidden' : 'hidden lg:block'))}>
          <div className="flex items-center gap-2 mb-1.5">
            {state === 'active' ? <CheckCircle2 size={12} className="text-[#16A34A]" /> : state === 'unknown' ? <Loader2 size={12} className="text-[#9CA3AF] animate-spin" /> : state === 'paused' || state === 'standby' ? <PauseCircle size={12} className="text-[#D97706]" /> : <AlertTriangle size={12} className={state === 'service_stopped' || state === 'entitlement' ? 'text-[#DC2626]' : 'text-[#9CA3AF]'} />}
            <span className="text-[11px] text-[#6B7280]">{AUTO_SEND_TEXT[state].label}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className={cx('w-2 h-2 rounded-full shrink-0', zaloDot)} />
            <span className="text-[11px] text-[#6B7280]">{zaloText}</span>
          </div>
        </div>

        <div className="border-t border-[#E2E8F0] p-3 flex items-center gap-2">
          <button onClick={() => go('ho-so')} aria-label="Hồ sơ tài khoản" className={cx('flex items-center gap-2 flex-1 min-w-0 rounded-lg hover:bg-[#F8FAFC] p-1 transition-colors', current === 'ho-so' && 'bg-[#F0FDFA]')}>
            <div className="w-7 h-7 rounded-full bg-[#CCFBF1] flex items-center justify-center shrink-0 text-[11px] font-semibold text-[#0F766E]">{initials(username)}</div>
            <div className={cx('min-w-0 text-left', !isMobile && (narrow ? 'hidden' : 'hidden lg:block'))}>
              <div className="text-[12px] font-medium text-[#172B2A] truncate">{username}</div>
              <div className="text-[10px] text-[#6B7280] truncate">{roleLabel}</div>
            </div>
          </button>
          {!isMobile && (
            <button onClick={() => setCollapsed((c) => !c)} aria-label={narrow ? 'Mở rộng menu' : 'Thu gọn menu'} className="hidden lg:flex w-6 h-6 rounded items-center justify-center hover:bg-[#F1F5F9] text-[#6B7280] shrink-0">
              {narrow ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
          )}
        </div>
      </aside>
    )
  }

  return (
    <>
      <div className="hidden md:flex h-full">{body(false)}</div>
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="fixed inset-0 bg-black/40" onClick={onCloseMobile} />
          <div className="relative h-full">{body(true)}</div>
        </div>
      )}
    </>
  )
}
