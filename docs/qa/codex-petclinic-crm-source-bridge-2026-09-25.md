# QA — cầu PETCLINIC → VETCLINIC CRM (2026-09-25)

## Phạm vi

- Chỉ thay đổi repo `customer-care-gateway`, nhánh `feat/vetclinic-crm-customer-ui`, nền commit `39bc84f`.
- Không sửa PETCLINIC, Platform Admin hoặc Sender; không commit, push, deploy hay chạy migration production.
- Mục tiêu: CRM tự nhận nguồn `PETCLINIC_ESSENTIAL`, đồng bộ lịch và xác minh lại ngay trước khi gửi.

## Đã triển khai

- Nhận bốn sự kiện Platform đã ký/chống replay: upsert, rotate credential, đổi trạng thái và revoke nguồn PETCLINIC.
- Envelope bắt buộc `version=1`, event/body ID khớp, tenant/product/source-installation UUID và revision tăng đơn điệu.
- Cùng event ID + đúng raw payload là idempotent; cùng ID + payload khác trả 409. Test đồng thời chứng minh chỉ một transaction được áp dụng.
- Ràng buộc tenant, product, HTTPS origin và phạm vi chi nhánh; token được mã hóa ngay và không xuất hiện trong phản hồi/audit/event.
- Chặn provisioning snapshot cũ; rotation và revoke là sự kiện bảo mật luôn thắng.
- Rotation thay token atomically. Nếu mất ACK, Platform phải phát rotation mới; CRM không yêu cầu/phục hồi token cũ.
- Đồng bộ phân trang bằng Bearer, không gửi tenant header; hỗ trợ cả `PETCLINIC_ESSENTIAL` và `PETCLINIC_OPERATING`.
- Job lưu `sourceAppointmentAt` + `sourceRevision`; dữ liệu snapshot sai bị từ chối.
- Worker gọi endpoint revalidate chuyên dụng với đúng snapshot ngay trước khi gửi. Chỉ `eligible=true` và `reasonCode=ELIGIBLE` mới được gửi; mọi lỗi đều fail closed.
- Revoke xóa credential, đóng installation và hủy job đang chờ/xử lý của đúng nguồn.
- Migration `0012_petclinic_source_provisioning` chỉ thêm cột/index, chạy sau cầu B2B `0011_b2b_source_bridge`, và phải được chạy thử hai lần trên PostgreSQL QA cô lập.

## Kết quả

| Hạng mục | Kết quả |
|---|---|
| Unit test sau khi hợp nhất cầu B2B + PETCLINIC | PASS 27/27 (10 suites) |
| Integration test PostgreSQL QA cô lập + HTTP loopback | PASS 117/117 (9 suites) |
| Test provisioning/replay/cách ly/rotate/suspend/revoke/không lộ token | PASS |
| Concurrent duplicate + event ID reused + stale revision | PASS |
| Build backend | PASS |
| Build web | PASS (cảnh báo chunk lớn có sẵn, không thất bại) |
| Migration deploy lần 1 | PASS, áp dụng 12 migrations (`0011` B2B, `0012` PETCLINIC) |
| Migration deploy lần 2 | PASS, không còn migration chờ |
| `git diff --check` | PASS |
| Prisma generate | PASS |
| E2E ba hệ thống sau bước hợp nhất remote B2B | NOT RUN; bằng chứng trước hợp nhất là PASS 53/53 hai lượt |
| Gửi Zalo thật | NOT RUN |
| Commit / push | PENDING sau khi hoàn tất rà secret và diff cuối |
| Deploy | NOT RUN theo giới hạn bàn giao |

## Điều kiện để tích hợp thật

1. PETCLINIC và Platform review, commit, triển khai hợp đồng nguồn tương ứng.
2. Đồng nhất `CRM_PLATFORM_EVENTS_SECRET` giữa Platform và CRM; không truyền secret qua trình duyệt.
3. Platform phát `petclinic_source.upserted` cho đúng tenant sau khi CRM tenant tồn tại.
4. Kiểm tra CRM sync được lịch, tạo job có snapshot, rồi thử revalidate trên một lịch giả/an toàn.
5. Chỉ bật worker/gửi thật sau khi anh Huy xác nhận riêng.

## Endpoint và cấu hình

- Nhận sự kiện: `POST /api/v1/crm/platform/events`.
- Đọc lịch: `GET {apiBaseUrl}/clinic-service/api/v1/clinic/appointments`.
- Xác minh trước gửi: `POST {apiBaseUrl}/clinic-service/api/v1/clinic/appointments/:id/revalidate`.
- CRM cần `CRM_PLATFORM_EVENTS_SECRET` (ít nhất 32 ký tự), cùng đúng giá trị với Platform cho kênh này.
- Credential PETCLINIC chỉ nằm ở CRM dưới dạng mã hóa bằng `DATA_ENCRYPTION_KEY_BASE64`; PETCLINIC tự giữ pepper/hash phía nó.

## Rollback

- Trước production: dừng worker/sync PETCLINIC, không phát thêm `petclinic_source.*`.
- Rollback ứng dụng về bản trước migration vẫn an toàn vì migration chỉ thêm cột nullable/default và index; không được tự ý xóa cột khi còn dữ liệu.
- Rollback vận hành từng nguồn bằng `petclinic_source.revoked`: credential bị xóa và job đang chờ của đúng installation bị hủy.
- Nếu cần rollback schema, phải xuất/kiểm tra dữ liệu mới và dùng migration thuận riêng; không dùng reset database.

## Kết luận

Phần nhận nguồn và fail-closed trong CRM đã sẵn sàng để review/commit. Chưa thể tuyên bố cầu production hoạt động cho tới khi hai đầu PETCLINIC/Platform được triển khai và hoàn thành E2E thật.

## Bổ sung 2026-09-25 — Claude: E2E thật ba hệ thống

- E2E với PETCLINIC/Platform thật (trước đây NOT RUN): **PASS 53/53 hai lượt** bằng harness
  `b2b-petclinic-crm-platform/scripts/qa/petclinic-crm-source-e2e.mjs`, CRM build hiện tại, DB QA riêng. Bước
  "xác minh trước khi gửi" chạy đúng `PetclinicSyncService.verify` đã build; worker gửi tắt, 0 DeliveryAttempt.
- Bằng chứng trước hợp nhất: unit 24/24, integration 116/116, build backend/web, Prisma validate, migrate deploy 2 lần — PASS.

## Bổ sung 2026-09-25 — hợp nhất an toàn với cầu B2B trên remote

- Dựng worktree mới từ `origin/feat/vetclinic-crm-customer-ui@5761837`; checkout bẩn ban đầu được giữ nguyên.
- Hợp nhất `source.changed` của B2B và `petclinic_source.*` trong cùng controller; worker revalidate đúng theo từng nguồn.
- Đổi migration PETCLINIC thành `0012_petclinic_source_provisioning` sau `0011_b2b_source_bridge`.
- Prisma generate PASS; backend build PASS; web build PASS (chỉ có cảnh báo chunk size có sẵn).
- Unit PASS 27/27; integration trên PostgreSQL QA cô lập PASS 117/117.
- Migration deploy lần 1 PASS đủ 12 migration; lần 2 PASS không còn migration chờ; status up to date.
- Không bật worker gửi, không gửi Zalo thật và không deploy.

## Xác minh E2E sau hợp nhất B2B (2026-09-25)

- Platform `cf72cf6` + PETCLINIC `249f838` + CRM `14287cd` chạy thật với ba database QA mới: **53/53 PASS, 0 FAIL**.
- Xác nhận `source.changed` B2B và `petclinic_source.*` cùng tồn tại trong mã CRM đã build; luồng PETCLINIC hoạt động, không có DeliveryAttempt và log không lộ secret/token/số điện thoại QA.
- Đây là kết quả local sau hợp nhất; smoke production được ghi riêng sau triển khai.
- Không sửa mã CRM; chỉ chỉnh `docs/crm-platform-contract.md` về quy tắc revision cho rotation và ý nghĩa `IGNORED_*`.
