import { useEffect, useState } from 'react'
import { ArrowLeft, Loader2, Scale } from 'lucide-react'

/**
 * Giấy phép & ghi công. Bản PC kèm "VETCLINIC Zalo Sender" (bản sửa đổi của ZaloCRM, GNU AGPL-3.0): nội dung NOTICE,
 * ghi công tác giả và link mã nguồn lấy nguyên văn từ Sender đang chạy (/api/v1/legal/sender) — không sửa, không rút gọn.
 */
export default function LicensePage() {
  const [text, setText] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    fetch('/api/v1/legal/sender', { credentials: 'same-origin' })
      .then(async (r) => { if (r.status === 404) setMissing(true); else setText(await r.text()) })
      .catch(() => setText('Không tải được nội dung giấy phép.'))
  }, [])
  return (
    <div className="min-h-screen bg-[#F6F8F8] px-4 py-8">
      <div className="max-w-[820px] mx-auto">
        <a href="#/" className="inline-flex items-center gap-1.5 text-[12px] text-[#0F766E] hover:underline mb-4"><ArrowLeft size={13} />Quay lại VETCLINIC CRM</a>
        <div className="bg-white border border-[#E2E8F0] rounded-[10px] p-6">
          <h1 className="flex items-center gap-2 text-[16px] font-semibold text-[#172B2A] mb-2"><Scale size={16} className="text-[#0F766E]" />Giấy phép và ghi công</h1>
          <p className="text-[12px] text-[#6B7280] mb-4">
            VETCLINIC CRM là phần mềm của VETCLINIC. Bản chạy trên máy tính kèm theo thành phần gửi tin Zalo là một bản sửa đổi
            của phần mềm mã nguồn mở ZaloCRM, được phát hành theo giấy phép GNU Affero General Public License v3.0. Nội dung giấy phép,
            ghi công tác giả và nơi lấy mã nguồn tương ứng được hiển thị nguyên văn dưới đây.
          </p>
          {missing ? <p className="text-[12px] text-[#6B7280]">Phiên bản này không kèm thành phần gửi tin chạy trên máy.</p>
            : text === null ? <div className="flex items-center gap-2 text-[12px] text-[#6B7280]"><Loader2 size={14} className="animate-spin" />Đang tải…</div>
            : <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[#374151] bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-4 max-h-[70vh] overflow-auto">{text}</pre>}
        </div>
      </div>
    </div>
  )
}
