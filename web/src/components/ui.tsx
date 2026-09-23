// Bộ component dùng chung — chuyển từ các khối lặp lại trong CRM GIAO DIEN.make, giữ nguyên
// kích thước/màu/khoảng cách của thiết kế nhưng gom về một chỗ để các trang dùng thống nhất.
import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, X, XCircle } from 'lucide-react'
import type { Tone } from '@/lib/format'

export const cx = (...v: (string | false | null | undefined)[]) => v.filter(Boolean).join(' ')

const CARD = 'bg-white border border-[#E2E8F0] rounded-[10px] shadow-[0_1px_3px_rgba(0,0,0,0.04)]'
export const cardClass = CARD

/* ---------- Button ---------- */
type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'warning' | 'ghost'
const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-[#0F766E] hover:bg-[#0D5F58] text-white font-semibold',
  secondary: 'border border-[#E2E8F0] bg-white text-[#374151] hover:bg-[#F8FAFC] font-medium',
  outline: 'border border-[#0F766E] text-[#0F766E] hover:bg-[#F0FDFA] font-medium',
  danger: 'border border-[#FECACA] text-[#DC2626] hover:bg-[#FEF2F2] font-medium',
  warning: 'bg-[#D97706] hover:bg-[#B45309] text-white font-semibold',
  ghost: 'text-[#0F766E] hover:underline font-medium',
}
export function Button({ variant = 'primary', size = 'md', loading, icon, children, className, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap',
        variant !== 'ghost' && (size === 'sm' ? 'h-8 px-3 text-[12px]' : 'h-9 px-4 text-[13px]'),
        variant === 'ghost' && 'text-[12px]',
        BUTTON[variant], className,
      )}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...rest} aria-label={label} title={label} className={cx('w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[#F1F5F9] text-[#6B7280] shrink-0', className)}>
      {children}
    </button>
  )
}

/* ---------- Field / Input / Select / Textarea ---------- */
const FIELD = 'border border-[#E2E8F0] rounded-lg text-[12px] text-[#172B2A] bg-white placeholder-[#9CA3AF] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/20 focus:border-[#0F766E] disabled:bg-[#F8FAFC] disabled:text-[#6B7280] disabled:cursor-not-allowed'
export function Field({ label, required, hint, error, children, htmlFor }: { label: string; required?: boolean; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[12px] font-medium text-[#374151] mb-1.5">
        {label} {required && <span className="text-[#DC2626]">*</span>}
      </label>
      {children}
      {error ? <p className="text-[11px] text-[#DC2626] mt-1">{error}</p> : hint ? <p className="text-[11px] text-[#9CA3AF] mt-1">{hint}</p> : null}
    </div>
  )
}
export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} aria-invalid={invalid || undefined} className={cx(FIELD, 'w-full h-9 px-3', invalid && 'border-[#DC2626]', className)} />
}
export function Textarea({ className, invalid, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea {...rest} aria-invalid={invalid || undefined} className={cx(FIELD, 'w-full px-3 py-2.5 leading-relaxed resize-none', invalid && 'border-[#DC2626]', className)} />
}
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={cx(FIELD, 'w-auto h-8 px-3 pr-7 text-[#374151]', className)}>{children}</select>
}

/* ---------- Badge ---------- */
const TONE: Record<Tone, string> = {
  brand: 'bg-[#F0FDFA] text-[#0F766E]',
  green: 'bg-[#F0FDF4] text-[#16A34A]',
  amber: 'bg-[#FFFBEB] text-[#B45309]',
  red: 'bg-[#FEF2F2] text-[#DC2626]',
  blue: 'bg-[#EFF6FF] text-[#1D4ED8]',
  gray: 'bg-[#F9FAFB] text-[#6B7280]',
}
export const TONE_TEXT: Record<Tone, string> = {
  brand: 'text-[#0F766E]', green: 'text-[#16A34A]', amber: 'text-[#D97706]', red: 'text-[#DC2626]', blue: 'text-[#1D4ED8]', gray: 'text-[#9CA3AF]',
}
export function Badge({ tone = 'gray', icon, children, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap', TONE[tone], className)}>{icon}{children}</span>
}

/* ---------- Page header ---------- */
export function PageHeader({ crumb, title, description, actions }: { crumb: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="text-[11px] text-[#6B7280] mb-1">VETCLINIC CRM / {crumb}</div>
        <h1 className="text-[20px] font-bold text-[#172B2A]">{title}</h1>
        {description && <p className="text-[13px] text-[#6B7280] mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}

/* ---------- KPI card ---------- */
export function KpiCard({ label, value, icon, color, bg, note }: { label: string; value: ReactNode; icon: ReactNode; color: string; bg: string; note?: string }) {
  return (
    <div className={cx(CARD, 'p-4')}>
      <div className="flex items-center justify-between mb-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: bg, color }}>{icon}</div>
        {note && <span className="text-[10px] text-[#9CA3AF]">{note}</span>}
      </div>
      <div className="text-[20px] font-bold text-[#172B2A] leading-none">{value}</div>
      <div className="text-[11px] text-[#6B7280] mt-1 leading-tight">{label}</div>
    </div>
  )
}

/* ---------- Alert ---------- */
const ALERT = {
  info: { box: 'bg-[#F0FDFA] border-[#99F6E4]', text: 'text-[#0F766E]', Icon: Info },
  warning: { box: 'bg-[#FFFBEB] border-[#FDE68A]', text: 'text-[#B45309]', Icon: AlertTriangle },
  error: { box: 'bg-[#FEF2F2] border-[#FECACA]', text: 'text-[#DC2626]', Icon: AlertCircle },
  success: { box: 'bg-[#F0FDF4] border-[#BBF7D0]', text: 'text-[#16A34A]', Icon: CheckCircle2 },
}
export function Alert({ kind = 'info', title, children, action, className }: { kind?: keyof typeof ALERT; title?: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  const a = ALERT[kind]
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={cx('flex items-start gap-3 border rounded-[10px] px-4 py-3', a.box, className)}>
      <a.Icon size={15} className={cx('shrink-0 mt-0.5', a.text)} />
      <div className="flex-1 min-w-0">
        {title && <div className={cx('text-[12px] font-semibold', a.text)}>{title}</div>}
        {children && <div className={cx('text-[11px] leading-relaxed', title ? 'mt-0.5' : '', a.text)}>{children}</div>}
      </div>
      {action}
    </div>
  )
}

/* ---------- Empty / Error / Skeleton ---------- */
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-10">
      {icon && <div className="w-10 h-10 rounded-full bg-[#F0FDFA] text-[#0F766E] flex items-center justify-center mb-3">{icon}</div>}
      <div className="text-[13px] font-semibold text-[#172B2A]">{title}</div>
      {description && <div className="text-[12px] text-[#6B7280] mt-1 max-w-[420px]">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-10">
      <div className="w-10 h-10 rounded-full bg-[#FEF2F2] text-[#DC2626] flex items-center justify-center mb-3"><XCircle size={18} /></div>
      <div className="text-[13px] font-semibold text-[#172B2A]">Không tải được dữ liệu</div>
      <div className="text-[12px] text-[#6B7280] mt-1 max-w-[420px]">{message}</div>
      {onRetry && <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>Thử lại</Button>}
    </div>
  )
}
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('crm-skeleton bg-[#EEF2F4] rounded-md', className)} />
}
export function TableSkeleton({ rows = 6, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="p-4 space-y-3" aria-busy="true" aria-label="Đang tải">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">{Array.from({ length: cols }).map((__, c) => <Skeleton key={c} className="h-4 flex-1" />)}</div>
      ))}
    </div>
  )
}

/* ---------- Table ---------- */
export function DataTable({ headers, children, footer, minWidth = 720 }: { headers: ReactNode[]; children: ReactNode; footer?: ReactNode; minWidth?: number }) {
  return (
    <div className={cx(CARD, 'overflow-hidden')}>
      <div className="overflow-x-auto">
        <table className="w-full" style={{ minWidth }}>
          <thead>
            <tr className="border-b border-[#F1F5F9] bg-[#FAFAFA]">
              {headers.map((h, i) => <th key={i} className="px-3 py-3 first:pl-4 text-left text-[11px] font-semibold text-[#6B7280] whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {footer}
    </div>
  )
}
export const rowClass = 'border-b border-[#F8FAFC] hover:bg-[#F8FAFC] transition-colors last:border-0'
export const cellClass = 'px-3 py-3 first:pl-4'

export function Pagination({ page, pageCount, total, from, to, unit, onPage }: { page: number; pageCount: number; total: number; from: number; to: number; unit: string; onPage: (p: number) => void }) {
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1).filter((n) => n === 1 || n === pageCount || Math.abs(n - page) <= 1)
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-4 py-3 border-t border-[#F1F5F9]">
      <div className="text-[12px] text-[#6B7280]">{total ? `Hiển thị ${from}–${to} / ${total} ${unit}` : `0 ${unit}`}</div>
      <div className="flex items-center gap-1">
        <button aria-label="Trang trước" disabled={page <= 1} onClick={() => onPage(page - 1)} className="w-7 h-7 flex items-center justify-center rounded border border-[#E2E8F0] text-[#6B7280] hover:bg-[#F8FAFC] disabled:opacity-40"><ChevronLeft size={13} /></button>
        {pages.map((n, i) => (
          <span key={n} className="flex items-center gap-1">
            {i > 0 && n - pages[i - 1] > 1 && <span className="text-[12px] text-[#9CA3AF] px-0.5">…</span>}
            <button onClick={() => onPage(n)} aria-current={page === n ? 'page' : undefined} className={cx('min-w-7 h-7 px-1.5 flex items-center justify-center rounded border text-[12px] font-medium transition-colors', page === n ? 'bg-[#0F766E] border-[#0F766E] text-white' : 'border-[#E2E8F0] text-[#6B7280] hover:bg-[#F8FAFC]')}>{n}</button>
          </span>
        ))}
        <button aria-label="Trang sau" disabled={page >= pageCount} onClick={() => onPage(page + 1)} className="w-7 h-7 flex items-center justify-center rounded border border-[#E2E8F0] text-[#6B7280] hover:bg-[#F8FAFC] disabled:opacity-40"><ChevronRight size={13} /></button>
      </div>
    </div>
  )
}

export function usePagination<T>(rows: T[], pageSize = 20) {
  const [page, setPage] = useState(1)
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const current = Math.min(page, pageCount)
  const start = (current - 1) * pageSize
  return {
    page: current, pageCount, setPage,
    slice: rows.slice(start, start + pageSize),
    from: rows.length ? start + 1 : 0, to: Math.min(start + pageSize, rows.length), total: rows.length,
  }
}

/* ---------- Tabs (segmented, như bộ lọc thời gian trong thiết kế) ---------- */
export function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex items-center bg-white border border-[#E2E8F0] rounded-lg p-0.5">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cx('px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors', value === o.value ? 'bg-[#0F766E] text-white' : 'text-[#6B7280] hover:text-[#172B2A]')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ---------- Modal ---------- */
function useEscape(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, active])
}
export function Modal({ open, title, subtitle, onClose, children, footer, width = 520 }: { open: boolean; title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const id = useId()
  useEscape(onClose, open)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (open) ref.current?.focus() }, [open])
  if (!open) return null
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} className="bg-white rounded-[12px] border border-[#E2E8F0] shadow-xl w-full max-h-[90vh] overflow-hidden flex flex-col outline-none" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#F1F5F9]">
          <div className="min-w-0">
            <div id={id} className="text-[14px] font-semibold text-[#172B2A]">{title}</div>
            {subtitle && <div className="mt-0.5">{subtitle}</div>}
          </div>
          <IconButton label="Đóng" onClick={onClose}><X size={14} /></IconButton>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex gap-2 px-5 py-4 border-t border-[#F1F5F9]">{footer}</div>}
      </div>
    </div>
  )
}

/* ---------- Confirmation dialog ---------- */
export function ConfirmDialog({ open, title, subtitle, icon, tone = 'warning', children, confirmLabel, onCancel, onConfirm, loading, error }: {
  open: boolean; title: string; subtitle?: string; icon: ReactNode; tone?: 'warning' | 'danger'; children: ReactNode
  confirmLabel: string; onCancel: () => void; onConfirm: () => void; loading?: boolean; error?: string
}) {
  useEscape(onCancel, open && !loading)
  if (!open) return null
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div role="alertdialog" aria-modal="true" aria-label={title} className="bg-white rounded-[12px] border border-[#E2E8F0] shadow-xl p-6 w-full max-w-[400px]">
        <div className="flex items-center gap-3 mb-3">
          <div className={cx('w-10 h-10 rounded-full flex items-center justify-center shrink-0', tone === 'danger' ? 'bg-[#FEF2F2] text-[#DC2626]' : 'bg-[#FFFBEB] text-[#D97706]')}>{icon}</div>
          <div>
            <div className="text-[14px] font-bold text-[#172B2A]">{title}</div>
            {subtitle && <div className="text-[12px] text-[#6B7280]">{subtitle}</div>}
          </div>
        </div>
        <div className="text-[12px] text-[#374151] mb-4">{children}</div>
        {error && <Alert kind="error" className="mb-4">{error}</Alert>}
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1 text-[12px]" onClick={onCancel} disabled={loading}>Hủy</Button>
          <Button variant={tone === 'danger' ? 'primary' : 'warning'} className={cx('flex-1 text-[12px]', tone === 'danger' && '!bg-[#DC2626] hover:!bg-[#B91C1C]')} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  )
}

/* ---------- Drawer (panel phải: cố định trong bố cục ở desktop, phủ màn hình ở mobile) ---------- */
export function Drawer({ open, title, subtitle, onClose, children, footer }: { open: boolean; title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEscape(onClose, open)
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40 lg:hidden" onClick={onClose} />
      <aside aria-label={typeof title === 'string' ? title : 'Chi tiết'} className="fixed inset-y-0 right-0 z-50 w-full sm:w-[380px] lg:w-[360px] lg:static lg:z-auto shrink-0 bg-white border-l border-[#E2E8F0] flex flex-col overflow-hidden lg:h-full">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#F1F5F9]">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[#172B2A] truncate">{title}</div>
            {subtitle && <div className="text-[11px] font-mono text-[#9CA3AF] truncate">{subtitle}</div>}
          </div>
          <IconButton label="Đóng" onClick={onClose}><X size={14} /></IconButton>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-[#F1F5F9] flex gap-2">{footer}</div>}
      </aside>
    </>
  )
}

export function InfoList({ title, rows }: { title: string; rows: [string, ReactNode][] }) {
  return (
    <div className="bg-[#F8FAFC] rounded-lg p-3 space-y-2">
      <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-wide mb-2">{title}</div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 text-[12px]">
          <span className="text-[#6B7280] shrink-0">{k}</span>
          <span className="font-medium text-[#172B2A] text-right break-all">{v}</span>
        </div>
      ))}
    </div>
  )
}
export const SectionLabel = ({ children }: { children: ReactNode }) => <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-wide mb-2">{children}</div>

/* ---------- Toast ---------- */
type ToastItem = { id: number; kind: 'success' | 'error' | 'info'; message: string }
const ToastCtx = createContext<(kind: ToastItem['kind'], message: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((kind: ToastItem['kind'], message: string) => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x, { id, kind, message }])
    window.setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4500)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[60] flex flex-col gap-2 sm:w-[340px]" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('flex items-start gap-2 rounded-lg border px-3 py-2.5 shadow-lg bg-white text-[12px]',
            t.kind === 'success' ? 'border-[#BBF7D0] text-[#166534]' : t.kind === 'error' ? 'border-[#FECACA] text-[#B91C1C]' : 'border-[#E2E8F0] text-[#172B2A]')}>
            {t.kind === 'success' ? <CheckCircle2 size={14} className="shrink-0 mt-0.5 text-[#16A34A]" /> : t.kind === 'error' ? <AlertCircle size={14} className="shrink-0 mt-0.5 text-[#DC2626]" /> : <Info size={14} className="shrink-0 mt-0.5 text-[#0F766E]" />}
            <span className="flex-1">{t.message}</span>
            <button aria-label="Đóng thông báo" onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))} className="text-[#9CA3AF] hover:text-[#6B7280]"><X size={12} /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/* ---------- Checkbox & Switch ---------- */
export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return <input type="checkbox" aria-label={label} checked={checked} onChange={onChange} onClick={(e) => e.stopPropagation()} className="w-3.5 h-3.5 accent-[#0F766E] cursor-pointer" />
}
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('w-10 h-[22px] rounded-full relative transition-colors shrink-0 disabled:opacity-60 disabled:cursor-not-allowed', checked ? 'bg-[#0F766E]' : 'bg-[#E2E8F0]')}>
      <span className={cx('absolute top-[3px] left-0 w-4 h-4 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-[21px]' : 'translate-x-[3px]')} />
    </button>
  )
}
