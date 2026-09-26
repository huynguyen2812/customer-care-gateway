import { useCallback, useEffect, useState } from 'react'
import { Loader2, Menu, PawPrint } from 'lucide-react'
import Sidebar from './components/Sidebar'
import { ToastProvider } from './components/ui'
import { ACCESS_BLOCKED_EVENT, api, ApiError, SESSION_EXPIRED_EVENT } from './lib/api'
import { CrmDataProvider } from './lib/data'
import type { Me } from './lib/types'
import { navigate, readRoute, type Route } from './routes'
import { AccessBlocked, Login } from './pages/Login'
import Dashboard from './pages/Dashboard'
import Customers from './pages/Customers'
import DataSources from './pages/DataSources'
import ZaloChannel from './pages/ZaloChannel'
import MessageTemplates from './pages/MessageTemplates'
import SendQueue from './pages/SendQueue'
import OptoutList from './pages/OptoutList'
import AuditLogs from './pages/AuditLogs'
import Settings from './pages/Settings'
import AdminProfile from './pages/AdminProfile'
import NoPermission from './pages/NoPermission'
import StandaloneSettings from './pages/StandaloneSettings'
import LicensePage from './pages/LicensePage'
import PlatformConnection from './pages/PlatformConnection'

type Auth = { status: 'checking' } | { status: 'anonymous'; reason?: string } | { status: 'blocked'; reason: string } | { status: 'authenticated'; me: Me }

/** Lỗi đăng nhập từ callback SSO được gửi về dạng /#loi=<MÃ>; đọc một lần rồi xóa khỏi URL. */
function takeLoginError(): string | undefined {
  const m = window.location.hash.match(/^#loi=([A-Z_]{3,40})$/)
  if (!m) return undefined
  history.replaceState(null, '', '/')
  return m[1]
}

const ROUTE_PERMISSION: Partial<Record<Route, Me['permissions'][number]>> = {
  'khach-hang': 'crm.customers.read', 'nguon-du-lieu': 'crm.sources.read', 'kenh-zalo': 'crm.zalo.read', 'mau-tin-nhan': 'crm.templates.read',
  'hang-doi': 'crm.jobs.read', 'tu-choi-nhan-tin': 'crm.optouts.read', 'nhat-ky': 'crm.audit.read', 'cai-dat': 'crm.settings.read',
  'tai-khoan-ket-noi': 'crm.sources.read',
  'ket-noi-platform': 'crm.settings.read',
}

export default function App() {
  const [loginError] = useState(takeLoginError)
  const [auth, setAuth] = useState<Auth>(() => (loginError ? { status: 'anonymous', reason: loginError } : { status: 'checking' }))
  const [route, setRoute] = useState<Route>(readRoute)
  const [mobileNav, setMobileNav] = useState(false)

  const checkSession = useCallback(async () => {
    try {
      setAuth({ status: 'authenticated', me: await api.me() })
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined
      if (e instanceof ApiError && e.status === 403 && code) setAuth({ status: 'blocked', reason: code })
      else setAuth({ status: 'anonymous', reason: code === 'ACCESS_REVOKED' || code === 'SESSION_EXPIRED' || code === 'PLATFORM_UNAVAILABLE' ? code : undefined })
    }
  }, [])

  useEffect(() => { if (auth.status === 'checking') void checkSession() }, [auth.status, checkSession])

  useEffect(() => {
    const onHash = () => setRoute(readRoute())
    const onExpired = (e: Event) => setAuth({ status: 'anonymous', reason: String((e as CustomEvent).detail || 'SESSION_EXPIRED') })
    const onBlocked = (e: Event) => setAuth({ status: 'blocked', reason: String((e as CustomEvent).detail || 'ENTITLEMENT_INACTIVE') })
    window.addEventListener('hashchange', onHash)
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    window.addEventListener(ACCESS_BLOCKED_EVENT, onBlocked)
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired); window.removeEventListener(ACCESS_BLOCKED_EVENT, onBlocked) }
  }, [])

  useEffect(() => { document.getElementById('crm-main')?.scrollTo({ top: 0 }) }, [route])

  const logout = useCallback(async () => {
    try { await api.logout() } finally { setAuth({ status: 'anonymous', reason: 'LOGGED_OUT' }) }
  }, [])

  // Giấy phép & ghi công: xem được cả khi chưa đăng nhập.
  if (route === 'giay-phep') return <LicensePage />

  if (auth.status === 'checking') {
    return (
      <div className="min-h-screen bg-[#F6F8F8] flex flex-col items-center justify-center gap-3 text-[#6B7280]" aria-busy="true">
        <div className="w-12 h-12 rounded-xl bg-[#0F766E] flex items-center justify-center"><PawPrint size={24} color="white" aria-hidden /></div>
        <div className="flex items-center gap-2 text-[12px]"><Loader2 size={14} className="animate-spin" /> Đang kiểm tra phiên đăng nhập…</div>
      </div>
    )
  }
  if (auth.status === 'anonymous') return <Login reason={auth.reason} onAuthenticated={() => setAuth({ status: 'checking' })} />
  if (auth.status === 'blocked') return <AccessBlocked reason={auth.reason} onLogout={() => void logout()} />

  const me = auth.me
  const needed = ROUTE_PERMISSION[route]
  const allowed = (!needed || me.permissions.includes(needed)) && (!['tai-khoan-ket-noi', 'ket-noi-platform'].includes(route) || me.mode === 'standalone')
  const pages: Record<Route, React.ReactNode> = {
    'tong-quan': <Dashboard />,
    'khach-hang': <Customers />,
    'nguon-du-lieu': <DataSources />,
    'kenh-zalo': <ZaloChannel />,
    'mau-tin-nhan': <MessageTemplates />,
    'hang-doi': <SendQueue />,
    'tu-choi-nhan-tin': <OptoutList />,
    'nhat-ky': <AuditLogs />,
    'cai-dat': <Settings />,
    'ho-so': <AdminProfile onLogout={logout} />,
    'tai-khoan-ket-noi': <StandaloneSettings />,
    'giay-phep': <LicensePage />,
    'ket-noi-platform': <PlatformConnection />,
  }

  return (
    <ToastProvider>
      <CrmDataProvider me={me}>
        <div className="flex h-screen bg-[#F6F8F8] overflow-hidden">
          <Sidebar current={route} onNavigate={navigate} mobileOpen={mobileNav} onCloseMobile={() => setMobileNav(false)} />
          <div className="flex-1 min-w-0 flex flex-col">
            <header className="md:hidden flex items-center gap-3 h-14 px-4 bg-white border-b border-[#E2E8F0] shrink-0">
              <button aria-label="Mở menu" onClick={() => setMobileNav(true)} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[#F1F5F9] text-[#374151]"><Menu size={18} /></button>
              <div className="w-7 h-7 rounded-lg bg-[#0F766E] flex items-center justify-center"><PawPrint size={14} color="white" aria-hidden /></div>
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-[#172B2A] leading-tight">VETCLINIC CRM</div>
                <div className="text-[10px] text-[#6B7280] leading-tight">Chăm sóc khách hàng</div>
              </div>
            </header>
            <main id="crm-main" className="flex-1 min-w-0 overflow-auto">{allowed ? pages[route] : <NoPermission />}</main>
          </div>
        </div>
      </CrmDataProvider>
    </ToastProvider>
  )
}
