import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import type { InstallationSummary, Me, MessageTemplate, Permission, Settings, ZaloAccountList } from './types'

type Resource<T> = { data: T | null; error: string | null }
export interface CrmData {
  me: Me
  can: (p: Permission) => boolean
  loading: boolean
  refreshedAt: Date | null
  installations: Resource<InstallationSummary[]>
  templates: Resource<MessageTemplate[]>
  settings: Resource<Settings>
  zalo: Resource<ZaloAccountList>
  reload: () => Promise<void>
}

const empty = { data: null, error: null }
const Ctx = createContext<CrmData | null>(null)

async function settle<T>(allowed: boolean, p: () => Promise<T>): Promise<Resource<T>> {
  if (!allowed) return { data: null, error: 'Bạn không có quyền xem mục này.' }
  try { return { data: await p(), error: null } } catch (e) { return { data: null, error: e instanceof Error ? e.message : 'Lỗi không xác định' } }
}

/** Dữ liệu dùng chung (nguồn dữ liệu, mẫu tin, cài đặt) — tải khi vào ứng dụng và khi làm mới; không tự gọi lặp. */
export function CrmDataProvider({ me, children }: { me: Me; children: ReactNode }) {
  const can = useCallback((p: Permission) => me.permissions.includes(p), [me])
  const [state, setState] = useState({ loading: true, refreshedAt: null as Date | null, installations: empty as Resource<InstallationSummary[]>, templates: empty as Resource<MessageTemplate[]>, settings: empty as Resource<Settings>, zalo: empty as Resource<ZaloAccountList> })
  const inFlight = useRef<Promise<void> | null>(null)
  const reload = useCallback(() => {
    if (inFlight.current) return inFlight.current
    setState((s) => ({ ...s, loading: true }))
    const run = (async () => {
      const [installations, templates, settings, zalo] = await Promise.all([
        settle(can('crm.sources.read'), api.installations), settle(can('crm.templates.read'), api.templates), settle(can('crm.settings.read'), api.settings), settle(can('crm.zalo.read'), api.zaloAccounts),
      ])
      setState({ loading: false, refreshedAt: new Date(), installations, templates, settings, zalo })
    })().finally(() => { inFlight.current = null })
    inFlight.current = run
    return run
  }, [can])
  useEffect(() => { void reload() }, [reload])
  return <Ctx.Provider value={{ ...state, me, can, reload }}>{children}</Ctx.Provider>
}

export function useCrm(): CrmData {
  const v = useContext(Ctx)
  if (!v) throw new Error('useCrm must be used inside CrmDataProvider')
  return v
}

export type AutoSendState = 'unknown' | 'active' | 'standby' | 'paused' | 'service_stopped' | 'no_connection' | 'entitlement'

/**
 * Trạng thái "Tự động gửi" theo ngôn ngữ khách hàng, lấy từ /crm/settings (dữ liệu thật của tenant):
 * gói còn hiệu lực, tenant có tạm dừng không, dịch vụ gửi có đang tạm ngưng, và tiến trình gửi có bật.
 */
export function autoSendState(settings: Settings | null): AutoSendState {
  if (!settings) return 'unknown'
  if (!settings.entitlement.usable) return 'entitlement'
  if (!settings.sendingService.available) return 'service_stopped'
  if (!settings.installations.some((i) => i.status === 'ACTIVE')) return 'no_connection'
  if (settings.autoSendPaused) return 'paused'
  return settings.workerRunning ? 'active' : 'standby'
}

export const AUTO_SEND_TEXT: Record<AutoSendState, { label: string; short: string; tone: 'green' | 'amber' | 'red' | 'gray' }> = {
  active: { label: 'Tự động gửi đang hoạt động', short: 'Đang hoạt động', tone: 'green' },
  standby: { label: 'Tự động gửi đang bật (chờ dịch vụ gửi)', short: 'Đang bật', tone: 'amber' },
  paused: { label: 'Tự động gửi đã tạm dừng', short: 'Đã tạm dừng', tone: 'amber' },
  service_stopped: { label: 'Dịch vụ gửi tin đang tạm ngưng', short: 'Dịch vụ tạm ngưng', tone: 'red' },
  no_connection: { label: 'Chưa có kết nối dữ liệu', short: 'Chưa có kết nối', tone: 'gray' },
  entitlement: { label: 'Gói dịch vụ không còn hiệu lực', short: 'Gói hết hiệu lực', tone: 'red' },
  unknown: { label: 'Đang kiểm tra trạng thái', short: 'Đang kiểm tra', tone: 'gray' },
}

export type ZaloSummary = 'none' | 'all' | 'partial' | 'relogin' | 'down' | 'unknown'
/** Tóm tắt nhiều tài khoản Zalo cho thanh bên: tất cả hoạt động / một phần / cần đăng nhập lại / chưa có. */
export function zaloSummary(list: ZaloAccountList | null): { state: ZaloSummary; usable: number; total: number } {
  if (!list) return { state: 'unknown', usable: 0, total: 0 }
  const total = list.accounts.length
  const usable = list.accounts.filter((a) => a.usable).length
  if (!total) return { state: 'none', usable, total }
  if (usable === total) return { state: 'all', usable, total }
  if (list.accounts.some((a) => a.status === 'RELOGIN_REQUIRED')) return { state: 'relogin', usable, total }
  return { state: usable ? 'partial' : 'down', usable, total }
}
