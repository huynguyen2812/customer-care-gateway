# Runbook chuyển đổi: VETCLINIC CRM trên VPS → VETCLINIC CRM chạy trên PC

- **Trạng thái:** TÀI LIỆU. **Chưa thực hiện bước production nào.**
  Không tắt `crm.vetclinic.vn`, không dừng Sender/worker trên VPS, không xóa database, không đổi DNS.
- **Mỗi bước đánh dấu [PROD]:** cần anh Huy duyệt rõ ràng trong hội thoại. Theo quy tắc dự án, Codex/anh Huy là người thực hiện.

## Điều kiện trước khi bắt đầu (tất cả phải PASS)

| # | Điều kiện | Ai | Trạng thái hiện tại |
|---|---|---|---|
| 1 | Commit + push source sạch của 2 repo (`customer-care-gateway`, `vetclinic-zalo-sender`) sau khi Codex review | Codex/anh Huy | Chưa (đang ở working tree, chờ review) |
| 2 | Build bản truy nguyên được: `release.ps1` không có `-AllowDirty`, manifest có `build.crmCommit/senderCommit`, `dirty=false` | Claude/Codex | Chưa (bản 0.3.0-dev là bản thử từ source chưa commit) |
| 3 | Cài trên **máy Windows sạch** (không có công cụ dev): cài mới, khôi phục, gỡ, khởi động lại Windows | Claude + anh Huy | Chưa chạy |
| 4 | Kiểm tra updater với **HTTPS thật** `https://vetclinic.vn/tai-ve/crm-pc/` (đăng file theo `huong-dan-dang-ban-cap-nhat.md`) | Codex/anh Huy [PROD: upload web] | Chưa chạy |
| 5 | **Pilot Platform ↔ PC**: Platform hiện thực contract `platform-device-contract-v1.md` trên staging; ghép bằng mã thật, đồng bộ cấu hình, thu hồi, hết hạn | Task B2B + Claude | Chưa (mới có Platform giả lập) |
| 6 | Pilot Zalo thật trên 1 PC (anh Huy cho phép riêng): đăng nhập QR, gửi thử cho số của anh Huy | anh Huy | Chưa |

## Các bước chuyển một doanh nghiệp

> Làm lần lượt **từng doanh nghiệp**. VPS vẫn chạy cho các doanh nghiệp chưa chuyển.

1. **Commit/push source sạch.** Chỉ sau review của Codex và anh Huy duyệt.
2. **Build bản có thể truy nguyên.** Chạy `release.ps1 -Version x.y.z-pc` (không `-AllowDirty`). Lưu lại `SHA256SUMS.txt` và commit của bản build.
3. **Kiểm tra trên máy Windows sạch.** Cài mới → thiết lập → kích hoạt Platform staging → sao lưu → khôi phục sang máy khác (phải yêu cầu ghép lại) → gỡ (dữ liệu còn).
4. **Kiểm tra updater với HTTPS thật.** [PROD: upload web] Đăng bản N rồi N+1 lên `vetclinic.vn/tai-ve/crm-pc/`. Máy thử phải tự lên N+1, và phải tự quay về bản cũ khi gặp bản hỏng.
5. **Pilot Platform ↔ PC.** Doanh nghiệp thử được cấp gói. Platform sinh mã. Ghép PC. Kiểm tra heartbeat không có dữ liệu cá nhân, đổi chi nhánh/hạn mức (revision tăng), treo gói, thu hồi.
6. **Chuyển một doanh nghiệp.**
   - Cài PC tại khách, rồi kích hoạt bằng mã Platform.
   - Cấu hình nguồn PETCLINIC/B2B: khách hoặc kỹ thuật nhập khóa API **do PC tự sinh** vào hệ thống nguồn; không dùng lại credential của VPS.
   - Đăng nhập Zalo trên PC (quét QR).
   - Chạy xem trước (dry-run) để so sánh với VPS.
7. **Dừng enqueue trên VPS cho doanh nghiệp đó.** [PROD]
   - Tắt "tự động gửi" và tạm dừng installation nguồn của tenant trên VPS.
   - Để tránh gửi trùng: không để VPS và PC cùng nhắc một lịch hẹn. Chỉ bật tạo lịch nhắc trên PC **sau** bước này.
8. **Xử lý hàng đợi còn lại trên VPS.** [PROD]
   - Để VPS gửi nốt các tin đã đến hạn trong ngày, hoặc hủy tin QUEUED có ghi lý do `MIGRATED_TO_PC`.
   - Tin `DELIVERY_UNCERTAIN` phải được xem xét bằng tay, **không** gửi lại.
   - Đối chiếu số lượng trước/sau.
9. **Sao lưu và audit.** [PROD]
   - `pg_dump` database VPS; lưu audit của tenant.
   - Xác nhận PC đã có bản sao lưu đầu tiên hợp lệ (`backup.ps1 -Verify`).
10. **Thu hồi credential cũ.** [PROD]
    - Thu hồi installation credential cũ của tenant trên VPS và Platform events cho tenant đó.
    - Thu hồi tài khoản Zalo trên Sender VPS (**không** đăng xuất phiên Zalo nếu chưa chắc PC đã đăng nhập thành công).
11. **Dừng dịch vụ cũ.** [PROD] Chỉ khi **mọi** doanh nghiệp đã chuyển xong:
    - dừng worker và Sender trên VPS;
    - giữ database ở chế độ chỉ đọc một thời gian theo chính sách lưu trữ;
    - không xóa ngay.
12. **Đổi `crm.vetclinic.vn`.** [PROD: DNS/web] Chuyển thành trang tải về và hướng dẫn (trỏ tới `vetclinic.vn/tai-ve/crm-pc/`). Không dùng trang đăng nhập cũ.

## Quay lui

- **Trước bước 7:** chỉ cần gỡ PC. VPS vẫn phục vụ doanh nghiệp như cũ.
- **Sau bước 7, trước bước 10:** bật lại enqueue và auto-send trên VPS cho tenant đó, rồi tắt tạo lịch nhắc trên PC (bật dừng khẩn cấp trên PC).
- **Sau bước 10:** phải cấp lại credential trên VPS. Tránh tới bước này khi PC chưa chạy ổn định ít nhất 1–2 tuần.
