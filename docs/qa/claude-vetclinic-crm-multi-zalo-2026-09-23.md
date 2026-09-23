# Báo cáo bàn giao — VETCLINIC CRM đa tài khoản Zalo (Claude, 2026-09-23)

Repo: `D:\DuAn\customer-care-gateway` · Nhánh: `feat/vetclinic-crm-customer-ui` (dùng chung với 2 task CRM trước) ·
**Chưa commit, chưa push, chưa deploy.** Dừng chờ Codex review.

Trạng thái phân hệ: **Đã chạy kỹ thuật** (local, DB QA). Chưa được anh Huy duyệt. **Không production-ready**:
sender thật chưa hỗ trợ đa tài khoản (xem mục BLOCKED).

## 1. Kết quả tổng hợp

| Hạng mục | Kết quả |
|---|---|
| `npm run build` (backend) | PASS |
| `npm run build:web` (tsc + vite) | PASS (cảnh báo chunk > 500 kB, có từ trước) |
| `npm test` (unit) | PASS 22/22 (8 suite) |
| `npm run test:integration` (DB QA `ccg_multi_qa2`) | PASS 77/77 (6 suite, trong đó 36 test mới `multi-zalo.integration.spec.ts`) |
| Migration 0007 forward-only trên DB QA có dữ liệu legacy giả lập | PASS; `migrate deploy` lần 2: "No pending migrations" |
| Migration trên DB QA trống (`ccg_multi_e2e4`) + deploy lần 2 | PASS |
| `prisma validate` | PASS |
| `prisma migrate diff` DB ↔ schema | Chỉ còn 1 khác biệt đã biết: index `ZaloRoutingRule_scope_key` (xem §6) |
| Docker build local (`customer-care-gateway:multi-zalo-qa`, không push) | PASS |
| E2E trình duyệt 1440/768/375 (Platform giả QA, Chrome headless) | PASS 42/42 |
| Gửi Zalo thật / QR thật / tài khoản thật / migration production / deploy | NOT RUN (không được phép) |
| QR login, preflight, idempotent send, remote control với sender thật | BLOCKED (sender chưa có contract v2) |
| Gửi đa tài khoản + failover trên sender thật | BLOCKED |

## 2. Đã làm

### Dữ liệu (prisma/schema.prisma, migration `0007_multi_zalo_accounts`)
- `ZaloAccount` thuộc tenant (`tenantId`), nhiều tài khoản/tenant; enum `ZaloAccountStatus` 10 trạng thái;
  `paused`, `priority`, `isDefault` (partial unique: 1 mặc định/tenant), `dailyQuota`, `timezone`,
  `capabilities`, `sessionVersion`, sender config riêng từng tài khoản (mã hóa), `lastActiveAt`, `revokedAt`.
  `installationId` không còn unique/bắt buộc (SET NULL).
- `ZaloRoutingRule` (installation/branch/eventType/priority/active), FK kép `(id, tenantId)`; index duy nhất
  `NULLS NOT DISTINCT`.
- `CareJob.branchId`, `selectedZaloAccountId` (sticky), `selectedChannel`.
- `DeliveryAttempt` (sổ lượt gửi): FK kép theo tenant; partial unique ≤ 1 `SENT` và ≤ 1 lượt mở/job.
- `DeliveryQuotaCounter` (scope TENANT/INSTALLATION/ACCOUNT × ngày, CHECK used ≥ 0).
- `CrmTenant.tenantDailyQuota`, `timezone`.
- Backfill: tenantId/quota/timezone từ installation; map trạng thái cũ (NEEDS_LOGIN→RELOGIN_REQUIRED,
  QR_PENDING→PENDING_LOGIN); tài khoản cũ nhất mỗi tenant = mặc định; tạo 1 rule installation cho mỗi
  tài khoản cũ (`createdBy='migration:0007'`) để hành vi cũ giữ nguyên. Không tạo CrmTenant cho tenant cũ.

### Gửi tin (src/worker, src/delivery, src/channel)
- Chọn tài khoản: chỉ tài khoản cùng tenant, dùng được, còn hạn mức; chi nhánh > nguồn > mặc định;
  sticky; không có tài khoản ⇒ requeue `NO_ELIGIBLE_ACCOUNT`, **không bao giờ rơi về MOCK**.
- Mỗi lượt gửi: giữ hạn mức nguyên tử 3 tầng + tạo `DeliveryAttempt` trong 1 transaction → ghi
  `IN_FLIGHT` trước khi gọi mạng → gửi qua đúng tài khoản đã chọn.
- `SENT` / `NOT_SENT` (chắc chắn chưa gửi) / `UNKNOWN` (có thể đã gửi):
  - chỉ chuyển tài khoản khi NOT_SENT mức tài khoản; trả hạn mức;
  - UNKNOWN: gửi lại **cùng deliveryAttemptId, cùng tài khoản** nếu sender khai `idempotentSend`
    (tối đa 3 lần); nếu không ⇒ `FAILED/DELIVERY_UNCERTAIN`, giữ hạn mức, audit, không webhook.
- Khôi phục khi worker chết: job PROCESSING > 5 phút ⇒ QUEUED; lượt `RESERVED` ⇒ đóng "chưa gửi";
  lượt `IN_FLIGHT` ⇒ coi là UNKNOWN (không gửi mù lại).
- Adapter sender: phân loại v1 bảo thủ (timeout/423/429/5xx ⇒ UNKNOWN), tin trường `delivery` chỉ khi
  contractVersion ≥ 2; header `x-gateway-account-id`; QR/preflight/control chỉ khi có capability.
- ZNS ⇒ `CHANNEL_NOT_SUPPORTED` rõ ràng.
- **Sửa rủi ro cũ**: trước đây timeout bị coi là lỗi và worker thử lại tới 5 lần ⇒ có thể gửi trùng.
  Đã bỏ; và bỏ kiểm tra hạn mức kiểu đếm-rồi-gửi (race).

### API CRM (src/crm/zalo-accounts.service.ts, crm.controller.ts)
`GET/POST /crm/zalo-accounts`, `GET/PATCH /crm/zalo-accounts/:id`, `/pause`, `/resume`, `/disconnect`,
`/login/start`, `/login/status`, `GET/PUT /crm/zalo-routing-rules`; settings nhận `tenantDailyQuota`;
job detail có `deliveryAttempts[]`. Tenant lấy từ phiên, id ngoài tenant = 404 như id ngẫu nhiên,
không trả URL/khóa sender, số điện thoại che, mọi thao tác ghi audit. Chi tiết: `docs/api-contract.md`.

### Giao diện (web/src)
- **Kênh Zalo**: thẻ nhiều tài khoản (trạng thái, mặc định, số che, đã gửi/đang chờ/hạn mức, phân công,
  lý do không dùng được); Thêm/Sửa tài khoản; Đăng nhập/Đăng nhập lại (501 ⇒ "Chưa thể đăng nhập bằng mã QR",
  không QR giả); Tạm dừng/Bật lại/Ngắt kết nối có xác nhận; hộp **Phân công** (tài khoản × nguồn × chi nhánh × loại tin).
- **Cài đặt**: hạn mức chung doanh nghiệp; danh sách tài khoản với nút tạm dừng/bật lại từng tài khoản.
- **Hàng đợi**: cột "Tài khoản Zalo"; drawer có "Lượt gửi" và cảnh báo `DELIVERY_UNCERTAIN`.
- **Thanh bên**: tóm tắt "Zalo: x/y tài khoản hoạt động / có tài khoản cần đăng nhập lại / chưa có".
- Nhãn tiếng Việt cho mã lỗi và hành động audit mới. Bỏ `pendingApi` giả.

## 3. Test mới (test/multi-zalo.integration.spec.ts, 36 test, sender giả v2 có idempotency)
1. API: A tạo 3, B tạo 2 tài khoản; không lộ bí mật; **id của tenant khác và id ngẫu nhiên trả 404 giống hệt**
   trên 7 endpoint; rule chéo tenant 404, trùng 409, chi nhánh sai 400; viewer/staff không quản lý được;
   vượt hạn mức gói 403; QR 501 khi thiếu capability / trả QR khi có; pause/resume/disconnect có audit.
2. Routing: chi nhánh > nguồn > mặc định, rule theo loại tin; bỏ qua paused/relogin/restricted/
   disconnected/rate-limited/hết hạn mức; không bao giờ chọn tài khoản tenant khác; lưu tài khoản đã chọn +
   audit; sticky; không có tài khoản ⇒ requeue, 0 lần gọi sender, không MOCK; ZNS bị từ chối.
3. Chống trùng: 4 worker tranh 1 job ⇒ 1 lần gọi; timeout ⇒ không chuyển tài khoản, park, không webhook,
   giữ hạn mức; UNKNOWN + idempotent ⇒ cùng attempt id, Zalo nhận 1 tin; NOT_SENT ⇒ chuyển tài khoản,
   trả hạn mức; recipient not found ⇒ dừng; đã có providerMessageId ⇒ không gửi lại; restart IN_FLIGHT ⇒
   không gửi lại (hoặc cùng id nếu idempotent); restart RESERVED ⇒ đóng + gửi lượt mới; job treo ⇒ phục hồi;
   DB chặn SENT thứ 2 / lượt mở thứ 2 / attempt chéo tenant.
4. Hạn mức: 20 giao dịch tranh 5 suất cuối ⇒ đúng 5; rollback khi scope sau hết; tài khoản A hết ⇒ gửi qua B;
   6 worker song song, tenant cap 3 ⇒ đúng 3 tin; gói chặn cap cao hơn; đổi ngày theo múi giờ.
5. Tương thích: tenant legacy (không CrmTenant) + rule backfill + job chưa chọn tài khoản vẫn gửi;
   consent rút / opt-out / nguồn không hợp lệ / kill switch / giờ yên tĩnh vẫn chặn trước khi chạm tài khoản.

Test cũ được cập nhật: `worker-flow` (tài khoản MOCK tường minh), `crm-tenant` (`.body.accounts`),
`personal-zalo.adapter.spec` (5 test phân loại mới).

## 4. E2E trình duyệt (42/42 PASS)
Script: scratchpad `shots/e2e-multi.cjs`; dữ liệu giả `crm-qa-multi/seed.cjs`; Platform giả QA; DB `ccg_multi_e2e4`;
`WORKER_ENABLED=false`, `MOCK_ADAPTER_ENABLED=false`, sender trỏ tới loopback không có dịch vụ.
Ảnh: `docs/qa/screenshots/vetclinic-crm-multi-zalo-2026-09-23/` (12 ảnh 1440, 4 ảnh 768, 4 ảnh 375, `e2e-results.json`).
Bao gồm: SSO; thanh bên; 3 thẻ A không lẫn B; QR chưa hỗ trợ; thêm tài khoản; vượt gói; tạm dừng/bật lại;
phân công (validate + lưu thật); hàng đợi + lượt gửi chuyển tài khoản; cảnh báo chưa rõ kết quả; cài đặt hạn mức
doanh nghiệp (kiểm bằng API); nhật ký; nhân viên chỉ xem (API 403); người xem không thấy menu; B chỉ thấy 2 tài khoản
của B, id của A trả 404 giống id ngẫu nhiên; không cuộn ngang 768/375; không lỗi console; không gọi `/api/v1/admin`.

## 5. BLOCKED / NOT RUN
- **Sender thật (ZaloCRM-derived) chưa có contract v2**: QR login, preflight, gửi idempotent theo
  deliveryAttemptId, pause/disconnect phía sender, nhiều phiên tài khoản ⇒ BLOCKED. Handoff:
  `docs/multi-zalo-sender-contract.md`. Hệ quả: với sender hiện tại, mọi kết quả mơ hồ ⇒ park
  `DELIVERY_UNCERTAIN` (an toàn, không gửi trùng) — nhưng **failover thật và gửi đa tài khoản thật chưa kiểm được**.
- Health callback sender → Gateway: mới là đề xuất, chưa code.
- Platform thật (product `CUSTOMER_CARE_CRM`, plan `dailyQuotaMax`): BLOCKED như task trước.
- Production: không chạy migration, không deploy, không bật worker.

## 6. Vấn đề cần Codex quyết định
1. **Drift đã biết**: index `ZaloRoutingRule_scope_key` dùng `NULLS NOT DISTINCT` (Prisma không biểu diễn
   được) ⇒ `migrate diff` luôn đề xuất DROP. Không được chạy `migrate dev`; migration sau phải tay.
2. **DELIVERY_UNCERTAIN không gửi webhook** về nguồn (tránh nguồn tạo lại job ⇒ gửi trùng). Cần chốt
   nguồn có cần một trạng thái callback riêng (ví dụ `NEEDS_REVIEW`) hay không.
3. Trần 200 tin/ngày/tài khoản khi gói chưa có giới hạn — con số bảo thủ, cần anh Huy/Codex chốt.
4. Job cũ đang `QUEUED` với `failureCode` cũ `CHANNEL_UNAVAILABLE` sẽ đi luồng mới (chọn tài khoản theo rule
   backfill) — hợp lý nhưng nên rà trên bản sao dữ liệu thật trước production.
5. `test/crm-tenant.integration.spec.ts` vẫn có FakePlatform nội tuyến; bản dùng chung mới ở
   `test/helpers/fake-platform.ts` (chỉ multi-zalo dùng). Có thể gộp sau.
6. Đổi tên trường chi tiết job: danh sách lượt gửi trả về là `deliveryAttempts` (không ghi đè `attempts` = số lần thử).

## 7. File thay đổi (task này)
Mới: `prisma/migrations/0007_multi_zalo_accounts/migration.sql`, `src/common/day-key.ts`,
`src/delivery/{quota,account-selector}.service.ts`, `src/crm/zalo-accounts.service.ts`,
`test/multi-zalo.integration.spec.ts`, `test/helpers/fake-platform.ts`, `docs/multi-zalo-sender-contract.md`,
báo cáo này + ảnh.
Sửa: `prisma/schema.prisma`, `package.json` (script test:integration), `src/app.module.ts`,
`src/channel/{channel.adapter,channel.errors,mock.adapter,personal-zalo.adapter,channel-router.service}.ts`,
`src/worker/care-worker.service.ts`, `src/crm/{crm.controller,crm-data.service}.ts`,
`src/installations/installations.service.ts`, `src/admin/admin.service.ts`, `src/care-jobs/care-jobs.service.ts`,
`src/petclinic/petclinic-sync.service.ts`, test cũ (worker-flow, crm-tenant, personal-zalo adapter),
`web/src/{lib/types,lib/api,lib/data,lib/format}.ts(x)`, `web/src/pages/{ZaloChannel,Settings,SendQueue}.tsx`,
`web/src/components/Sidebar.tsx`, `README.md`, `docs/{api-contract,security,status}.md`.
Không đụng: 2 file `customer-care-gateway-*.tar.gz`, repo B2B/Platform Admin, sender ZaloCRM.

## 8. DB QA đã tạo (local container, không production)
`ccg_multi_qa` (bỏ, thay bằng qa2), `ccg_multi_qa2` (integration + legacy backfill), `ccg_multi_e2e`,
`ccg_multi_e2e2`, `ccg_multi_e2e3` (các lượt E2E trước, dữ liệu đã bị E2E thay đổi), `ccg_multi_e2e4` (lượt E2E cuối).
Có thể xóa khi Codex không cần nữa.

## 9. Trạng thái local
Server QA (port 4102) và Platform giả (4199) chỉ chạy để E2E và **đã tắt** sau khi xong; giao diện mới
**chưa hiện trên môi trường local thường ngày** cho tới khi Codex build/khởi động lại.
