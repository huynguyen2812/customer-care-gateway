// Định tuyến bằng hash (#/duong-dan) để NestJS chỉ cần phục vụ index.html tĩnh, không cần fallback SPA.
// Lỗi đăng nhập từ callback SSO dùng dạng /#loi=<MÃ> (xử lý trong App).
export type Route =
  | 'tong-quan' | 'khach-hang' | 'nguon-du-lieu' | 'kenh-zalo' | 'mau-tin-nhan'
  | 'hang-doi' | 'tu-choi-nhan-tin' | 'nhat-ky' | 'cai-dat' | 'ho-so'

export const ROUTES: Route[] = ['tong-quan', 'khach-hang', 'nguon-du-lieu', 'kenh-zalo', 'mau-tin-nhan', 'hang-doi', 'tu-choi-nhan-tin', 'nhat-ky', 'cai-dat', 'ho-so']

export function readRoute(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  return (ROUTES as string[]).includes(raw) ? (raw as Route) : 'tong-quan'
}

export function navigate(route: Route) {
  if (window.location.hash !== `#/${route}`) window.location.hash = `/${route}`
}
