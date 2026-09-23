# Báo cáo: VETCLINIC CRM an toàn theo tenant và tích hợp Platform Admin — 2026-09-23

- Người thực hiện: Claude.
- Trạng thái: **Đã chạy kỹ thuật trên local (DB QA riêng, Platform giả lập). Đang chờ Codex review.**
- E2E với Platform thật: **BLOCKED**. Không tuyên bố sẵn sàng production.

## 1. Nhánh, HEAD, trạng thái Git

| Mục | Giá trị |
|---|---|
| Repo | `D:\DuAn\customer-care-gateway`. Không có `AGENTS.md`/`AI-SYNC.md` riêng; áp dụng `b2b-sales-management/AGENTS.md` |
| Nhánh | `feat/vetclinic-crm-customer-ui` |
| HEAD | `0714a79` (**chưa commit**). Toàn bộ thay đổi giao diện của vòng trước được giữ nguyên |
| Staged | Chỉ có việc xóa `public/app.js`, `public/index.html`, `public/styles.css` (từ vòng trước) |
| Không đụng | `customer-care-gateway-0714a79.tar.gz`, `customer-care-gateway-d6c9d19.tar.gz` |
| Xung đột | Không. Backend/Prisma chưa có thay đổi của ai khác trước khi làm |
| Repo B2B/Platform | `main` sạch (sau khi Google SSO được gộp). Không sửa; chỉ đọc contract. Handoff ở `docs/crm-platform-contract.md` |
| Git | Chạy bằng `git -c safe.directory=…` theo từng lệnh (repo thuộc user `CodexSandboxOffline`); không sửa cấu hình global |

## 2. File đã thay đổi trong vòng này

Backend (mới) `src/crm/`:
- `crm.constants.ts`: role, permission, ánh xạ vai trò Platform, quy tắc entitlement.
- `crm-redact.ts`: che dữ liệu phía server.
- `platform-client.service.ts`: token-exchange, session-check, JWKS RS256.
- `crm-session.service.ts`: phiên phía server, CSRF, kiểm tra lại quyền định kỳ.
- `crm-auth.guard.ts`: xác thực, quyền, CSRF, Origin.
- `crm-auth.controller.ts`: start, callback, me, logout.
- `crm.controller.ts` và `crm-data.service.ts`: API tenant-scoped.
- `platform-events.controller.ts`: webhook có ký.
- `tenant-access.service.ts`: cổng chặn gửi tin cho worker và API tạo tác vụ.

Backend (sửa, tối thiểu):
- `app.module.ts`: đăng ký module.
- `care-jobs/care-jobs.service.ts`: chặn tạo tác vụ khi gói hết hiệu lực.
- `worker/care-worker.service.ts`: giữ hoặc hủy tác vụ theo gói và theo tạm dừng của tenant.
- `installations/installations.service.ts`, `petclinic/petclinic-sync.service.ts`: thêm tham số `actorType` (mặc định giữ `PLATFORM_ADMIN`) để nhật ký ghi đúng người thao tác CRM.

Prisma:
- `prisma/schema.prisma`: thêm 4 model.
- `prisma/migrations/0006_crm_tenant_access/migration.sql`: migration mới.

Test:
- Mới: `test/crm-tenant.integration.spec.ts` (34 test), `test/crm-permissions.spec.ts` (4 test).
- Sửa 3 test tích hợp cũ chỉ để truyền `TenantAccessService` vào constructor.
- `package.json`: thêm file test mới vào `test:integration`.

Frontend `web/src`:
- Viết lại: `lib/api.ts` (chỉ gọi `/api/v1/crm`), `lib/types.ts`, `lib/data.tsx`, `App.tsx`, `pages/Login.tsx` (SSO, màn bị chặn), `Dashboard`, `Customers`, `SendQueue`, `OptoutList`, `AuditLogs`, `Settings`, `AdminProfile`.
- Sửa: `Sidebar`, `DataSources`, `MessageTemplates`, `ZaloChannel`, `format.ts`, `routes.ts`.
- Mới: `pages/NoPermission.tsx`.

Tài liệu:
- `.env.example`: chỉ tên biến, placeholder.
- `README.md`, `docs/security.md`, `docs/status.md`.
- `docs/crm-platform-contract.md` (mới).
- Báo cáo này và ảnh trong `docs/qa/screenshots/vetclinic-crm-tenant-2026-09-23/`.

## 3. Luồng Platform Admin → CRM SSO → CRM session

```
[Trình duyệt] GET /api/v1/crm/auth/start
   └─ CRM: state 32 byte → cookie vc_crm_sso_state (HttpOnly, Lax, path /api/v1/crm/auth, 10')
   └─ 302 → {PLATFORM_WEB_ORIGIN}/product-launch/CUSTOMER_CARE_CRM?state=…
[Platform] đăng nhập → authorize (tenant, TenantProduct, UserProductAccess, installation) → code một lần
   └─ 302 → {CRM}/api/v1/crm/auth/platform/callback?code&installation=<clientId>&state
[CRM callback]
   1. state = cookie (constant-time); kiểm định dạng code/clientId
   2. CrmTenant theo clientId: installation ACTIVE, callbackBaseUrl == {CRM_PUBLIC_ORIGIN}/api/v1/crm
   3. POST {Platform}/platform-auth/token-exchange, dùng credential installation riêng của tenant
      (secret đã mã hóa AES-GCM trong DB CRM)
   4. JWT RS256: kid/JWKS, iss, aud=CUSTOMER_CARE_CRM, exp, productCode, tenantId == tenant của
      installation, redirectUri (nếu có), entitlementStatus TRIAL/ACTIVE, cache gói còn hiệu lực
   5. jti chưa dùng (CrmSsoTokenReplay) → tạo CrmSession (token 32 byte, chỉ lưu SHA-256)
   6. Set-Cookie vc_crm_session (production: __Host-vc_crm_session; HttpOnly, Secure, Lax, 8h) → /#/tong-quan
[Mỗi request /api/v1/crm/*] CrmAuthGuard
   phiên chưa bị thu hồi và chưa hết hạn → CSRF (HMAC gắn với phiên) + Origin cùng nguồn nếu là thao tác ghi
   → gói còn hiệu lực (cache do webhook cập nhật) → cứ 60 giây gọi session-check
     (DENIED ⇒ thu hồi; mất kết nối ⇒ grace tới graceUntil của lần ACTIVE trước; hết grace ⇒ 503)
   → quyền của route (bắt buộc khai báo, thiếu thì từ chối)
```

## 4. Cách suy ra tenant phía server

- `CrmSession.platformTenantId` chỉ được đặt từ claim `tenantId` của JWT đã xác minh, và phải trùng
  với tenant của installation đã dùng để đổi code.
- Mọi truy vấn dữ liệu đi qua `CrmDataService`, với phạm vi `Installation.tenantId = session.platformTenantId`.
  ID do client gửi (installationId, careJobId, templateId, id khách hàng/opt-out) chỉ được tìm *bên trong*
  phạm vi này. Ngoài phạm vi thì trả `404 {code:"NOT_FOUND"}`, giống hệt ID không tồn tại.
- ID khách hàng và opt-out là HMAC không đoán được (pepper + installation + phoneHash). Không lộ phoneHash,
  không so khớp được giữa các tenant.
- Không endpoint CRM nào nhận `tenantId`/`userId`/`productCode` từ query, body, route hay header.

## 5. Endpoint admin cũ → endpoint CRM mới

| Admin cũ (giữ cho vận hành nội bộ) | CRM mới (tenant-scoped) | Quyền |
|---|---|---|
| `POST /admin/auth/login`, `setup` | `GET /crm/auth/start`, `GET /crm/auth/platform/callback` (SSO) | — |
| `GET /admin/auth/me` | `GET /crm/auth/me` | `crm.dashboard.read` |
| `POST /admin/auth/logout` | `POST /crm/auth/logout` (cần CSRF) | — |
| `GET /admin/overview` | `GET /crm/overview?period=today\|7d\|30d` | `crm.dashboard.read` |
| `GET /admin/installations` | `GET /crm/installations`, `GET /crm/installations/:id` | `crm.sources.read` |
| `POST /admin/installations/:id/petclinic` | `POST /crm/installations/:id/petclinic` (nhận token mới, không trả lại) | `crm.sources.manage` |
| `POST /admin/installations/:id/petclinic/preview` | `POST /crm/installations/:id/petclinic/preview` (dry-run) | `crm.sources.manage` |
| — | `GET /crm/customers`, `GET /crm/customers/:id` | `crm.customers.read` |
| `GET /admin/templates`, `POST /admin/installations/:id/templates` | `GET /crm/templates`, `POST /crm/templates`, `PATCH /crm/templates/:id` | `crm.templates.read` / `.manage` |
| `GET /admin/jobs` | `GET /crm/jobs` (lọc, tìm kiếm, phân trang, thống kê), `GET /crm/jobs/:id` | `crm.jobs.read` |
| `POST /admin/jobs/:id/cancel` | `POST /crm/jobs/:id/cancel`, `POST /crm/jobs/cancel {ids}` (kiểm từng ID) | `crm.jobs.cancel` |
| — | `GET /crm/opt-outs`, `DELETE /crm/opt-outs/:id {reason}` | `crm.optouts.read` / `.manage` |
| `GET /admin/audit` | `GET /crm/audit` (redact phía server) | `crm.audit.read` |
| `POST /admin/kill-switch` | **Không có** (toàn hệ thống, chỉ vận hành) | — |
| — | `GET /crm/settings`, `PATCH /crm/settings` (tạm dừng tenant, hạn mức ≤ gói, giờ yên tĩnh) | `crm.settings.read` / `.manage` |
| `POST /admin/installations/:id/personal-zalo` | `GET /crm/zalo-accounts` (chỉ đọc) | `crm.zalo.read` |
| `POST /admin/installations` | **Không có** (Platform cấp installation) | — |
| — | `POST /crm/platform/events` (webhook ký HMAC từ Platform) | chữ ký |

## 6. Role và permission

| Permission | CRM_OWNER | CRM_ADMIN | CRM_STAFF | CRM_VIEWER |
|---|---|---|---|---|
| dashboard/customers/templates/jobs/optouts/settings `.read` | ✓ | ✓ | ✓ | ✓ |
| `crm.sources.read`, `crm.zalo.read` | ✓ | ✓ | ✓ | — |
| `crm.audit.read` | ✓ | ✓ | — | — |
| `crm.jobs.cancel` | ✓ | ✓ | ✓ | — |
| `crm.templates.manage`, `crm.optouts.manage`, `crm.settings.manage`, `crm.zalo.manage`, `crm.customers.manage` | ✓ | ✓ | — | — |
| `crm.sources.manage` (thay credential nguồn) | ✓ | — | — | — |

- Không role nào có quyền Platform toàn cục (kill switch, tạo installation, tenant khác).
- Ánh xạ tạm từ vai trò Platform:
  - `ADMIN`/`TENANT_ADMIN` → `CRM_OWNER`;
  - vai trò khác → `CRM_STAFF`;
  - giá trị lạ hoặc rỗng → `CRM_VIEWER`.
- Nếu Platform gửi claim `crmRoles` hợp lệ thì dùng claim đó (xem handoff).
- `crm.customers.manage` và `crm.zalo.manage` đã được định nghĩa nhưng chưa có thao tác nào dùng.

## 7. Migration

| Migration | Nội dung | Đã chạy ở đâu | Kết quả |
|---|---|---|---|
| `0006_crm_tenant_access` (forward-only, additive) | `CrmTenant` (PK platformTenantId, `platformClientId` unique), `CrmSession` (tokenHash unique, FK → CrmTenant **CASCADE**, index tenant+user, expiresAt), `CrmSsoTokenReplay`, `PlatformEvent` (PK eventId) | Chỉ DB QA `ccg_crm_qa` trong container local `customer-care-gateway-postgres-1` (`migrate deploy`) | PASS |
| Chạy lại lần 2 | `No pending migrations to apply` / `Database schema is up to date` | `ccg_crm_qa` | PASS |
| DB dev local `customer_care_gateway` | Không áp migration 0006 | — | NOT RUN (cố ý) |
| Production | — | — | NOT RUN |

SQL được sinh bằng `prisma migrate diff` so với DB QA đã có 0001–0005. Diff chỉ gồm bảng/index/FK mới.
Không dùng `migrate dev`, không reset.

## 8. Test tenant A/B (`test/crm-tenant.integration.spec.ts`, PostgreSQL QA thật + HTTP thật)

| Tình huống | Kết quả |
|---|---|
| Overview, installations, templates, jobs, zalo, audit của A chỉ chứa dữ liệu A (đếm chính xác) | PASS |
| Lọc `installationId` của B trong jobs/audit → 0 kết quả | PASS |
| Khách hàng: danh sách/thống kê A chỉ có A; đọc khách của B → 404; số điện thoại đã che | PASS |
| A không sửa được template B, không tạo template vào installation B | PASS |
| A không hủy được job B (đơn lẻ → 404; hàng loạt → `NOT_FOUND`); job B vẫn `QUEUED` | PASS |
| A không gỡ được opt-out của B (404, B vẫn còn 1 bản ghi) | PASS |
| A không đổi được settings của installation B (404, hạn mức B giữ nguyên 20) | PASS |
| A không preview nguồn của B (404) | PASS |
| `user_product_access.revoked` của A không ảnh hưởng phiên B | PASS |

## 9. Test IDOR

| ID | Cách thử | Kết quả |
|---|---|---|
| installationId | `GET /crm/installations/{B}`, `POST …/{B}/petclinic/preview`, `PATCH settings {id:B}`, `POST templates {installationId:B}` | PASS: 404 |
| careJobId | `GET /crm/jobs/{B}`, `POST /crm/jobs/{B}/cancel`, bulk cancel | PASS: 404 / NOT_FOUND |
| templateId | `PATCH /crm/templates/{B}` | PASS: 404 |
| customerId | `GET /crm/customers/{id của B}` | PASS: 404 |
| optOutId | `DELETE /crm/opt-outs/{id của B}` | PASS: 404 |
| audit target | `GET /crm/audit?installationId={B}` | PASS: 0 kết quả; không lộ ID của B |
| zaloAccountId | Chỉ có danh sách của tenant; chưa có thao tác theo ID | PASS (danh sách) / NOT RUN (thao tác, chưa có) |
| Oracle | Body 404 cho ID của B **giống hệt** ID ngẫu nhiên | PASS |

## 10. Test entitlement, SSO, quyền

| Nhóm | Tình huống | Kết quả |
|---|---|---|
| SSO | Code hợp lệ → phiên đúng tenant, cookie HttpOnly/Lax, `/me` không có secret | PASS |
| SSO | Code hết hạn / đã dùng / sai state (không gọi Platform) / sai redirect / sai product code / code qua installation tenant khác / clientId lạ | PASS: bị từ chối |
| SSO | Tenant bị khóa, user không có UserProductAccess (Platform trả 403) | PASS: bị từ chối |
| SSO | Gói hết hạn trong token hoặc trong cache | PASS: bị từ chối |
| SSO | Replay `jti` | PASS: bị từ chối |
| Phiên | Đăng xuất thu hồi phía server; phiên đã thu hồi → 401 | PASS |
| Phiên | CSRF thiếu / sai / của phiên khác; Origin khác nguồn | PASS: 403 |
| Phiên | Không có phiên → 401; cookie CRM không mở được `/admin/*` và `kill-switch` | PASS |
| Phiên | session-check DENIED → thu hồi; Platform down trong grace → cho qua; hết grace → 503 | PASS |
| Quyền | Viewer: đọc được, không sửa được, không xem audit | PASS |
| Quyền | Staff: hủy job được; không quản lý template/settings/audit | PASS |
| Quyền | Admin: không thay credential nguồn; Owner: được (chỉ tenant mình) | PASS |
| Quyền | `crmRoles` lạ không nâng quyền | PASS |
| Gói | Tạm dừng → phiên thu hồi, đăng nhập lại bị chặn, API tạo tác vụ trả `ENTITLEMENT_SUSPENDED`, **worker thật giữ** tác vụ đến hạn và không gọi kênh gửi | PASS |
| Gói | Hết hạn → **worker thật hủy** tác vụ (`ENTITLEMENT_EXPIRED`) | PASS |
| Gói | Kích hoạt lại → đăng nhập lại được | PASS |
| Gói | `installation.revoked` → thu hồi mọi phiên, xóa secret, đăng nhập bị chặn | PASS |
| Cài đặt | Tạm dừng tenant → worker `HOLD TENANT_PAUSED`; bật lại → `SEND`; hạn mức > gói → 403; giờ sai định dạng hoặc bắt đầu = kết thúc → 400 | PASS |
| Gỡ opt-out | Thiếu lý do → 400; có lý do → gỡ và ghi audit đúng người | PASS |
| Redaction | Audit không lộ `apiToken`, số điện thoại bị che; lỗi job che số; installation không có trường secret | PASS |

## 11. Test webhook chữ ký / replay

| Tình huống | Kết quả |
|---|---|
| Sai chữ ký / body bị sửa / timestamp cũ hơn 5 phút → 401, trạng thái không đổi | PASS |
| Gửi lại cùng `eventId` → `duplicate:true`; đúng 1 bản ghi `PlatformEvent` và 1 audit | PASS |
| Sự kiện cũ đến trễ không kéo trạng thái gói lùi lại (`IGNORED_STALE`) | PASS |
| Chữ ký được kiểm trên raw body trước khi đọc tenant | PASS (theo code; test sửa body và sai chữ ký đều bị chặn) |

## 12. Build, test và frontend

| Hạng mục | Kết quả |
|---|---|
| `npm run build:web` (tsc + vite) | PASS (cảnh báo chunk JS lớn do recharts, như vòng trước) |
| `npm run build` (nest) | PASS |
| `npm test` | PASS 8 suite / 18 test |
| `npm run test:integration` trên `ccg_crm_qa` | PASS 5 suite / 41 test |
| Docker build local `customer-care-gateway:crm-tenant-qa-local` (có `dist/crm`, migration 0006, UI) | PASS (không push) |
| E2E trình duyệt (headless Chrome, Platform giả QA, DB QA, 2 tenant giả lập) | PASS 39/39 |
| Đăng nhập chỉ qua VETCLINIC, không có ô mật khẩu; cookie HttpOnly/Lax; không có token trong storage | PASS |
| 11 màn tải được; Khách hàng, Hàng đợi, Nhật ký, Từ chối nhận tin, Cài đặt dùng API thật | PASS |
| Người xem: ẩn menu không có quyền, mở thẳng URL → thông báo không có quyền, gọi thẳng API → 403 | PASS |
| Tenant B chỉ thấy dữ liệu B; B đọc job A → 404 | PASS |
| Gói tạm dừng → về màn đăng nhập, đăng nhập lại có thông báo; kích hoạt lại → vào được | PASS |
| Đăng xuất bền sau khi tải lại trang | PASS |
| Không cuộn ngang ở 768 và 375 (5 màn mỗi cỡ) | PASS |
| Giao diện không gọi `/api/v1/admin/*`; không có lỗi console/JS | PASS |
| Setup/login mật khẩu cũ | Chỉ còn ở API `/api/v1/admin/auth/*` cho vận hành nội bộ. Giao diện khách không còn dùng. Chưa có console nội bộ riêng; cần quyết định (mục 14) |

Ảnh bằng chứng: `docs/qa/screenshots/vetclinic-crm-tenant-2026-09-23/`.
- 1440px, đủ 11 màn: `impl-1440-00…10-*.png`.
- Các ảnh bổ sung: `impl-1440-02b-khach-hang-drawer`, `06b-hang-doi-drawer`, `07b-go-opt-out`, `09b-da-tam-dung`, `goi-tam-dung`, `viewer-khong-co-quyen`.
- 768/375: `impl-768-*.png`, `impl-375-*.png`.

## 13. Những gì đã nối thật

- SSO consumer đúng contract Platform hiện có:
  - `token-exchange` kèm `x-installation-client-id/secret`;
  - `session-check` có quyết định ACTIVE/DENIED và grace;
  - JWKS RS256;
  - callback `/auth/platform/callback?code&installation&state`.
- Webhook provisioning/gói/quyền: cùng khuôn chữ ký TIMEKEEPING.
- Đủ các API `/crm/*` ở mục 5. Toàn bộ giao diện đã chuyển sang các API này.
- Khách hàng, Từ chối nhận tin (có gỡ kèm lý do) và Cài đặt tenant nay có API thật. Vòng trước ba màn này ở trạng thái chưa có dữ liệu.
- Worker và API tạo tác vụ tuân theo gói và theo tạm dừng của tenant.

## 14. BLOCKED / còn thiếu / cần quyết định

| Mục | Trạng thái | Lý do |
|---|---|---|
| E2E với Platform thật | BLOCKED | Platform chưa có `CUSTOMER_CARE_CRM` (enum, catalog, installation), launcher `/product-launch/CUSTOMER_CARE_CRM`, và chưa phát sự kiện tới CRM. Xem `docs/crm-platform-contract.md` |
| Vai trò CRM chi tiết (OWNER/ADMIN/STAFF/VIEWER) do Platform cấp | BLOCKED | Platform chỉ phát `ADMIN`/`STAFF`; cần claim `crmRoles`. Hiện chưa có đường tạo `CRM_ADMIN`/`CRM_VIEWER` từ Platform thật |
| Hạn mức gói (`limits.dailyQuotaMax`) | BLOCKED | Platform chưa gửi; không có giới hạn thì CRM chỉ cho giảm hạn mức |
| Claim `redirectUri` trong token | BLOCKED (tăng cường) | CRM đã kiểm nếu có; hiện ràng buộc bằng `callbackBaseUrl` đã provision |
| Kết nối Zalo bằng QR, ngắt kết nối, tạm dừng từng tài khoản | BLOCKED | Sender chưa có API theo tenant; giao diện giữ trạng thái "chưa hỗ trợ", không có API giả |
| Đổi mật khẩu | Chuyển sang Platform | CRM không quản lý mật khẩu; có liên kết `{PLATFORM_WEB_ORIGIN}/account` (Platform cần xác nhận đường dẫn) |
| Nội dung tin đã cá nhân hóa / thử gửi lại trong drawer | NOT RUN | Chưa có API; ngoài phạm vi |
| Console vận hành nội bộ (giao diện cho `/api/v1/admin/*`) | Cần quyết định | Giao diện hiện chỉ dành cho khách. Đề xuất: chặn `/api/v1/admin/*` ở reverse proxy của `crm.vetclinic.vn` và làm console nội bộ trên hostname riêng |
| Chính sách đọc lịch sử khi gói hết hạn | Cần quyết định | Hiện gói tạm dừng/hết hạn chặn toàn bộ CRM (fail-closed), vì contract Platform thu hồi phiên khi session-check trả DENIED |
| Tenant không có bản ghi `CrmTenant` (installation pilot nội bộ cũ) | Cần quyết định | Worker vẫn gửi như trước để không phá pilot. Khi mọi tenant đi qua Platform, nên đổi sang fail-closed |
| Khách hàng: suy ra từ tác vụ (tối đa 5.000 nhóm mỗi tenant, xử lý trong bộ nhớ) | Hạn chế đã biết | Đủ cho MVP; quy mô lớn cần bảng projection riêng (migration sau) |

## 15. Xác nhận

- Worker vẫn tắt (`WORKER_ENABLED=false` ở mọi lần chạy). Test worker gọi `processNext()` trực tiếp chỉ cho nhánh giữ/hủy, và đã kiểm chứng kênh gửi **không** bị gọi.
- Không gửi Zalo thật, chỉ adapter MOCK.
- Không dùng dữ liệu thật: 2 tenant, người dùng và số điện thoại đều giả lập (`+849000…`). Không sao chép credential từ PETCLINIC/B2B/Platform.
- Không migration production. Không đụng DB dev `customer_care_gateway` bằng migration mới. Không đổi DNS, không deploy, không commit, không push, không tạo PR.
- Còn lại trên máy local, có thể dọn khi Codex không cần:
  - DB QA `ccg_crm_qa`, `ccg_ui_qa`;
  - image `customer-care-gateway:crm-tenant-qa-local`, `customer-care-gateway:ui-qa-local`;
  - script và Platform giả lập trong thư mục tạm của phiên (không nằm trong repo).
