import { ShieldOff } from 'lucide-react'
import { EmptyState, cardClass } from '@/components/ui'

export default function NoPermission() {
  return (
    <div className="p-4 sm:p-6">
      <div className={cardClass}>
        <EmptyState icon={<ShieldOff size={18} />} title="Bạn không có quyền xem mục này" description="Quyền truy cập do quản trị doanh nghiệp cấp trên tài khoản VETCLINIC. Liên hệ quản trị doanh nghiệp nếu bạn cần dùng chức năng này." />
      </div>
    </div>
  )
}
