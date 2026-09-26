# VETCLINIC CRM — Bản chạy độc lập trên PC (Standalone PC Edition)

## Giai đoạn 1, bước 1: khảo sát trước khi code (2026-09-25, Claude)

Trạng thái: **Đang làm** (giai đoạn 1). Bước 1 khảo sát: xong. Bước 2: **Đã chạy kỹ thuật**, xem `qa-buoc-2-2026-09-25.md`. Chưa commit/push/deploy.

---

## 1. Trạng thái repo (ghi lại trước khi sửa)

| | CRM (customer-care-gateway) | Sender (vetclinic-zalo-sender) |
|---|---|---|
| Thư mục gốc (KHÔNG đụng) | `D:\DuAn\customer-care-gateway`: nhánh `feat/vetclinic-crm-customer-ui`, HEAD `39bc84f`, **có 12 file đã sửa + 4 file/thư mục mới chưa commit của Codex** (petclinic bridge, `0011_petclinic_source_provisioning`) | `D:\DuAn\ZaloCRM-upstream`: nhánh `feat/multi-zalo-sender-v2`, HEAD `fda67b3c`, sạch |
| Bản clone làm việc | `D:\DuAn\crm-standalone\customer-care-gateway` | `D:\DuAn\crm-standalone\vetclinic-zalo-sender` |
| Nhánh mới | `feat/standalone-pc-edition` từ `5581357` (= đỉnh `origin/main`) | `feat/standalone-pc-edition` từ `fda67b3c` |
| Remote | `origin` = github huynguyen2812/customer-care-gateway | `vetclinic` = github huynguyen2812/vetclinic-zalo-sender; `upstream-zalocrm` = repo ZaloCRM gốc, **push bị vô hiệu** (`DISABLED`) |
| Dirty | sạch (chỉ có file báo cáo này) | sạch |

Cách tạo clone: `git clone --no-checkout` từ bản local (chỉ đọc object, không sửa working tree gốc). Thư mục
CRM gốc thuộc sở hữu user `CodexSandboxOffline` nên em dùng `-c safe.directory` theo từng lệnh, **không**
đổi cấu hình git toàn cục.

Ghi nhận thêm (không xử lý): migration WIP của Codex tên `0011_petclinic_source_provisioning`, còn trên
`main` đã là `0012_petclinic_source_provisioning` — Codex tự đối chiếu khi gộp.

## 2. File đã đọc

- Quy tắc: `AGENTS.md`, `AI-SYNC.md` (b2b-sales-management).
- CRM: `package.json`, `prisma/schema.prisma`, danh sách migration 0001–0012, `src/main.ts`, `src/app.module.ts`,
  `src/crm/{crm-auth.controller, crm-session.service, crm-auth.guard, tenant-access.service, crm.constants, crm.controller}.ts`,
  `src/crm/crm-data.service.ts` (lọc tenant), `src/auth/{hmac-auth.service, installation.guard}.ts`,
  `src/installations/installations.service.ts`, `src/care-jobs/care-jobs.service.ts`, `src/b2b/b2b-source.service.ts`,
  `src/petclinic/{petclinic-client.service, petclinic-sync.service, petclinic.types}.ts`,
  `src/worker/{care-worker.service, source-verifier.service, worker-runtime.service}.ts`, `src/common/crypto.service.ts`,
  `src/admin/admin-auth.service.ts`, commit `5581357`, `docs/{status, api-contract, security}.md`, `Dockerfile`, `docker-compose.yml`.
- Sender: `LICENSE`, `NOTICE`, `backend/package.json`, `backend/src/app.ts`, `backend/src/config/index.ts`,
  `backend/src/modules/gateway-v2/gateway-v2-auth.ts`, `backend/src/shared/{redis-client, zalo-session-codec}.ts`,
  `backend/src/shared/queue/redis-connection.ts`, danh sách import của `zalo-pool.ts`, danh sách file dùng Redis/BullMQ.

## 3. Kiến trúc hiện tại (bản VPS)

- **CRM**: NestJS 11 + Prisma 6 + PostgreSQL; web React/Vite build ra `public/` và được chính API phục vụ.
  Worker chạy **chung tiến trình** với API (`WORKER_ENABLED=true`, vòng lặp 1 giây, `FOR UPDATE SKIP LOCKED`).
- **Đăng nhập khách**: SSO Platform (code exchange RS256 → `CrmSession` HttpOnly + CSRF HMAC); quyền/gói lấy từ
  `CrmTenant` do Platform đẩy qua sự kiện ký HMAC; phiên được kiểm tra lại với Platform định kỳ.
- **Hệ thống ngoài gọi vào**: `Installation` + `ApiCredential` (clientId + secret hiện 1 lần; ký HMAC
  `METHOD\nPATH\nTS\nNONCE\nSHA256(body)` bằng `SHA256(secret)`; nonce lưu DB).
- **Nguồn dữ liệu**: PETCLINIC (Bearer, phân trang, dry-run, idempotencyKey theo lịch hẹn+revision,
  `revalidate` ngay trước khi gửi, lỗi mạng ⇒ không gửi) và B2B (qua Platform API, gửi secret trong header).
- **Gửi**: sổ `DeliveryAttempt` (id = deliveryAttemptId), IN_FLIGHT ghi trước khi gọi mạng, UNKNOWN không
  bao giờ failover, chỉ failover khi NOT_SENT chắc chắn; hạn mức 3 tầng nguyên tử; quiet hours; kill switch
  (`SystemSetting`), tạm dừng theo tenant.
- **Sender v2**: bản sửa ZaloCRM 3.4.0 (Fastify 5, Prisma 7, zca-js); khi chạy là **cả ứng dụng ZaloCRM**
  (hàng chục route + ~15 cron: nhắc lịch riêng của ZaloCRM, đồng bộ bạn bè, presence, Telegram, AI, quét
  nhóm BullMQ…) + module `gateway-v2`. Nonce v2 **bắt buộc Redis**; phiên Zalo mã hóa AES-GCM bằng `ZALO_SESSION_ENC_KEY`.

## 4. Thay đổi dự kiến

### 4.1 CRM (nhánh `feat/standalone-pc-edition`)

Nguyên tắc: thêm chế độ `DEPLOYMENT_MODE=standalone`; **mặc định vẫn là bản VPS** nên build/đường chạy cũ
không đổi. Migration chỉ thêm (forward-only, không xóa cột).

1. **Tài khoản cục bộ thay SSO Platform**
   - Bảng mới `LocalUser` (tenantId, username, băm scrypt N=2^15 + salt, vai trò CRM_OWNER/ADMIN/STAFF/VIEWER,
     đếm sai + khóa tạm, đổi mật khẩu thì thu hồi phiên).
   - Route mới `/api/v1/crm/local-auth/{status, setup, login, logout, me, change-password}` + quản lý nhân viên.
     Lần chạy đầu: tạo doanh nghiệp + chủ tài khoản. Giữ nguyên `CrmSession`/cookie HttpOnly/CSRF/kiểm Origin.
   - `CrmTenant` dùng lại: `platformTenantId` = UUID sinh cục bộ; `entitlementStatus=ACTIVE`, không hết hạn.
   - Ở chế độ standalone **không đăng ký**: `PlatformEventsController`, route SSO `start/callback`,
     `PlatformClientService` recheck, `/api/v1/admin/*` (bàn điều khiển vận hành nội bộ). Kill switch toàn máy
     chuyển thành quyền `CRM_OWNER` + nút trên khay hệ thống.
2. **API credential tự sinh cho mỗi doanh nghiệp**
   - Khi setup tạo 1 `Installation` nguồn `EXTERNAL_CONNECTOR` + 1 credential (clientId + secret hiện 1 lần).
   - Có xoay key (key cũ còn hiệu lực 24 giờ) và thu hồi. **Đề xuất cải thiện**: khóa ký HMAC hiện lưu dạng
     `SHA256(secret)` rõ trong DB (lộ bản dump DB là giả được chữ ký) ⇒ bản PC lưu khóa ký **đã mã hóa**
     AES-GCM (khóa dữ liệu được DPAPI bảo vệ).
   - Dùng cho (b) hệ thống ngoài gọi `POST /api/v1/care-jobs` trong LAN y như installation API hiện tại.
3. **Connector nguồn chung "VETCLINIC Source Connector v1"** (theo mẫu PETCLINIC/B2B)
   - Đặc tả: `GET {base}/appointments?from&to&page&size` và `GET {base}/receivables?...`,
     `POST {base}/appointments/{id}/revalidate` (`expectedAppointmentTime`, `expectedRevision`),
     `POST {base}/receivables/{id}/revalidate`. CRM **ký HMAC** bằng credential ở mục 2 (không gửi secret
     trong header như B2B hiện nay); bên nguồn kiểm chữ ký.
   - Giữ: dry-run mặc định, idempotencyKey theo id+thời điểm+revision, chi nhánh được duyệt, kiểm tra lại ngay
     trước khi gửi, nguồn không phản hồi ⇒ không gửi (xếp lại hàng).
   - Consent: nhắc lịch Zalo nhận `GRANTED`/`DEFAULT_ALLOWED` (channel=ZALO, purpose=APPOINTMENT_REMINDER);
     `REVOKED`/`WITHDRAWN`/`OPTED_OUT` luôn chặn; nhắc công nợ và mục đích khác bắt buộc `GRANTED`.
     Không thêm ô bắt chủ nuôi đồng ý.
   - Không truy cập DB sản phẩm khác.
4. **Tách vai trò tiến trình** `PROCESS_ROLE=api|worker|all` (mặc định `all` = như cũ). Worker chạy
   `createApplicationContext` (không mở cổng HTTP), có file nhịp tim để khay/chẩn đoán đọc.
5. **Không gửi dồn tin quá hạn sau khi tắt máy**: thêm luật hạn chót — việc đã quá `scheduledAt + N giờ`
   hoặc lịch hẹn đã/qua sắp diễn ra ⇒ `CANCELLED` mã `EXPIRED_WHILE_OFFLINE` (có ghi audit, không gửi).
   Việc đang `UNKNOWN` vẫn giữ nguyên quy tắc cũ (không tự gửi lại).
6. **Trang Giới thiệu/Giấy phép** trong CRM: hiển thị NOTICE + ghi công tác giả + link mã nguồn của Sender.

### 4.2 Sender (nhánh `feat/standalone-pc-edition`)

1. Điểm khởi động mới `src/sender-main.ts` (**chế độ chỉ-sender**): Fastify + route `gateway-v2` + `/health` +
   trang pháp lý; **không** frontend, không route/cron ZaloCRM khác (nhắc lịch riêng của ZaloCRM, Telegram, AI,
   quét nhóm BullMQ, presence…). `app.ts` gốc giữ nguyên.
2. Nonce v2 chuyển sang bảng PostgreSQL (`INSERT … ON CONFLICT DO NOTHING` + dọn định kỳ) ⇒ **không cần Redis**.
   Rate limiter/event-buffer vốn đã có chế độ in-memory khi không đặt `REDIS_URL`. Cần kiểm chứng: `zaloPool`
   kéo theo listener đồng bộ tin nhắn/lịch sử vào DB Sender — phải xác định bước kiểm tra "bạn bè/hội thoại
   đã có" có dựa vào dữ liệu đồng bộ này không trước khi tắt bớt (giảm dữ liệu cá nhân lưu trên PC).
3. `ZALO_SESSION_ENC_KEY` và `GATEWAY_SENDER_ENC_KEY` sinh khi cài, DPAPI bảo vệ ⇒ sang máy khác phải quét QR lại.
4. Giữ nguyên LICENSE, NOTICE, THIRD-PARTY-LICENSES, dòng SPDX; không dùng tên "ZaloCRM" cho sản phẩm.

### 4.3 Đóng gói Windows (thư mục mới `packaging/windows/` trong repo CRM)

| Hạng mục | Đề xuất |
|---|---|
| Bộ cài | Inno Setup 6, script `.iss` tái lập; ký số nếu có chứng thư |
| Chương trình | `C:\Program Files\VETCLINIC CRM\app\<version>\` (node 24 riêng, crm, sender, pgsql, winsw, tray) |
| Dữ liệu | `C:\ProgramData\VETCLINIC CRM\{db, secrets, logs, backup, sender}` — ACL: SYSTEM, Administrators, tài khoản dịch vụ |
| Service (WinSW) | `VetclinicCrmDb` (PostgreSQL 17 zip, 127.0.0.1:55432), `VetclinicCrmApi` (127.0.0.1:47100), `VetclinicCrmWorker`, `VetclinicCrmSender` (127.0.0.1:47110); phụ thuộc DB; tự khởi động (Delayed Auto) |
| Tài khoản dịch vụ | virtual account `NT SERVICE\<tên service>` (cần kiểm chứng WinSW hỗ trợ) |
| Secret | sinh khi cài bằng CSPRNG, bọc DPAPI LocalMachine + ACL; launcher giải mã rồi truyền qua stdin vào node (không ghi file rõ, không để trong biến môi trường hệ thống) |
| Redis | không cần (xem 4.2); dự phòng Garnet |
| Khay hệ thống | PowerShell + WinForms NotifyIcon (bản thử) |
| Cập nhật | manifest ký Ed25519 + SHA-256; backup → dừng khi còn job PROCESSING → migrate deploy → health check → lỗi thì quay về binary cũ (DB không rollback phá hủy) |
| Backup | `pg_dump -Fc` hằng ngày, mã hóa AES-256-GCM, giữ N bản, lệnh kiểm tra + restore thử vào DB tạm |
| Gỡ cài | dừng/gỡ service, xóa `Program Files`; **giữ `ProgramData`** trừ khi người dùng xác nhận xóa |

Lưu ý trung thực về DPAPI **LocalMachine**: mọi tiến trình trên máy đó đều giải mã được; lớp bảo vệ thật là ACL
thư mục secrets. Nó chống được việc sao chép ổ đĩa/bản backup sang máy khác, không chống được quản trị viên máy.

## 5. Rủi ro và cách lùi

| Rủi ro | Giảm thiểu / lùi |
|---|---|
| Làm hỏng bản VPS | Mọi thay đổi sau cờ `DEPLOYMENT_MODE=standalone`; mặc định cũ; chạy lại toàn bộ test hiện có |
| Migration | Chỉ thêm bảng/giá trị enum; không sửa migration cũ; lùi = bỏ nhánh (chưa có DB thật nào chạy) |
| Đụng việc của Codex | Làm trong clone riêng; không đọc/ghi working tree gốc ngoài lệnh `git status` chỉ đọc |
| Sender chỉ-sender thiếu dữ liệu hội thoại để preflight | Kiểm chứng trước khi tắt listener; nếu cần giữ đồng bộ tối thiểu |
| Gửi dồn sau khi mở máy | Luật hạn chót (4.1.5) + test khởi động lại |
| Virtual account/WinSW/pg_ctl trên Windows | Chạy thử trên máy ảo sạch, không trên máy dev |
| Pháp lý AGPL | Xem mục 7 |

## 6. Điểm cần anh Huy chốt

1. **Khóa khôi phục** — **ĐÃ CHỐT 2026-09-25: khách tự giữ.** Bộ cài sinh khóa khôi phục, hiển thị một lần
   (in giấy/QR), VETCLINIC **không** lưu bản sao. Hệ quả phải ghi rõ cho khách: mất khóa + hỏng PC = không khôi
   phục được bản backup mã hóa. Khóa này bọc khóa dữ liệu (`DATA_ENCRYPTION_KEY`, `PHONE_HASH_PEPPER`) và khóa
   backup; phiên Zalo không nằm trong phạm vi khôi phục (sang máy mới phải quét QR lại).
2. **Cho phép tải công cụ** — **ĐÃ CHỐT 2026-09-25: cho phép tải** (chỉ tải; chạy bộ cài Inno Setup xin phép
   riêng). Garnet chưa tải (chỉ dùng khi phương án bỏ Redis không đạt).
3. **Môi trường chạy thử** — **ĐÃ CHỐT 2026-09-25: cài thẳng lên máy dev của anh Huy.** Biện pháp giảm rủi ro:
   tên service riêng tiền tố `VetclinicCrm*`, cổng riêng 47100/47110/55432 chỉ 127.0.0.1, thư mục riêng
   `C:\Program Files\VETCLINIC CRM` + `C:\ProgramData\VETCLINIC CRM`, không đụng Docker/PostgreSQL 5441 của Codex,
   có script gỡ trả máy về như cũ. Cài service cần quyền Administrator (anh Huy bấm xác nhận UAC). Khởi động
   lại Windows vẫn phải xin phép riêng từng lần. Vẫn cần chạy lại trên máy sạch trước khi giao khách thật.
4. **ĐÃ CHỐT 2026-09-25: mỗi PC là 1 doanh nghiệp.** Màn thiết lập lần đầu tạo doanh nghiệp + chủ tài khoản;
   sau đó route thiết lập bị khóa vĩnh viễn (ràng buộc ở DB, không chỉ ở giao diện); chủ tự thêm nhân viên.
   Vẫn giữ tenantId trên mọi bảng + test cách ly A/B để không làm yếu bảo đảm hiện có.
5. **ĐÃ CHỐT 2026-09-25 (sửa lần 2): chỉ bỏ tin nếu đã trễ HƠN 12 GIỜ** so với giờ gửi dự kiến (`scheduledAt`)
   ⇒ `CANCELLED` mã `EXPIRED_WHILE_OFFLINE`, có audit, không gửi. Trễ dưới 12 giờ vẫn gửi (kể cả khi lịch hẹn đã
   qua — anh Huy muốn vẫn nhắn để khách hẹn lại). KHÔNG làm vế "lịch hẹn đã qua/còn dưới 1 giờ". Cấu hình bằng
   `CARE_JOB_MAX_LATENESS_HOURS` (bản PC mặc định 12; bản VPS mặc định tắt để không đổi hành vi). Việc
   `UNKNOWN`/đang có attempt mở giữ quy tắc cũ.
6. **ĐÃ TRẢ LỜI 2026-09-25: chưa có chứng thư ký số.** Bộ cài giai đoạn chạy thử sẽ KHÔNG ký; script build để
   sẵn bước ký tùy chọn (`signtool`, chỉ chạy khi có chứng thư) để sau này bật mà không sửa quy trình. Hệ quả:
   SmartScreen cảnh báo "Unknown publisher" khi cài. Lưu ý: manifest cập nhật vẫn ký Ed25519 bằng khóa riêng của
   VETCLINIC (không phụ thuộc chứng thư thương mại) nên updater vẫn kiểm được file cập nhật là thật.
7. **ĐÃ CHỐT 2026-09-25: cập nhật tự kiểm tra qua web của VETCLINIC.** Thiết kế: updater định kỳ đọc manifest
   HTTPS (URL cấu hình được, chưa chốt tên miền) ký Ed25519 → tải gói → kiểm SHA-256 → chỉ cài khi không còn job
   PROCESSING → backup → migrate forward-only → health check → lỗi thì quay về binary cũ. Web cập nhật sập/mất
   mạng thì CRM vẫn chạy bình thường (chỉ không có bản mới). Khóa công khai Ed25519 nhúng trong bộ cài; khóa bí
   mật do VETCLINIC giữ, không nằm trong repo. Việc dựng web cập nhật thật (máy chủ, tên miền) là phần riêng,
   chưa làm, cần anh Huy duyệt khi tới bước đó.

## 7. Pháp lý (bắt buộc nêu)

- Cài Sender (bản sửa đổi ZaloCRM, AGPL-3.0) lên máy khách là **"conveying"** ⇒ phải cung cấp **mã nguồn
  tương ứng** cho khách (em đề xuất kèm file zip mã nguồn Sender trong bộ cài + link repo), giữ LICENSE/NOTICE.
- NOTICE có điều khoản bổ sung §7b yêu cầu giữ ghi công tác giả (banner "contact-marquee" trong giao diện
  ZaloCRM) và §13 link mã nguồn. Chế độ chỉ-sender **không có giao diện ZaloCRM** ⇒ phải có nơi hiển thị
  thay thế (trang Giấy phép trong CRM + trang pháp lý của Sender + mục trên khay). Việc này có đủ đáp ứng §7b
  hay không **cần luật sư xác nhận trước khi giao khách thật**. Em sẽ không gỡ/ẩn ghi công.
- §7e: không dùng tên/logo "ZaloCRM" cho sản phẩm.
- Không tuyên bố production-ready ở giai đoạn này.

## 8. Kế hoạch tiếp theo (sau khi anh Huy chốt mục 6)

Bước 2 (tài khoản cục bộ + credential + connector, có unit/integration test trên DB QA riêng) có thể làm
ngay vì không cần tải công cụ — chỉ cần PostgreSQL QA (dùng Docker Desktop đã có trên máy, container và cổng
riêng, không đụng DB 5441 của Codex). Bước 3 (bộ chạy thử Windows service) cần mục 6.2 và 6.3.
