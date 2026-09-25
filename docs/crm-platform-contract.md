# Contract Platform Admin ⇄ VETCLINIC CRM (`CUSTOMER_CARE_CRM`)

Trạng thái (2026-09-24): **cả hai phía đã triển khai; E2E local với Platform thật qua HTTP thật +
DB thật: PASS** (harness `scripts/qa/crm-platform-e2e.mjs` trong repo Platform, báo cáo
`docs/qa/claude-platform-crm-e2e-and-deletion-2026-09-24.md` bên đó). Các nhãn **[PLATFORM CẦN
LÀM]** bên dưới là lịch sử handoff: catalog, launcher, sự kiện, `crmRoles`, `planCode/limits`,
`redirectUri` đã có phía Platform (chưa commit, chờ Codex review). Chưa production-approved.

Nguyên tắc: Platform là nguồn sự thật về tenant, người dùng, `TenantProduct`, `UserProductAccess`,
`PlatformProductInstallation`, gói/hạn mức. CRM chỉ cache những gì Platform gửi qua kênh có chữ ký, và
luôn suy ra tenant từ phiên phía server. CRM không đọc database của Platform/B2B/PETCLINIC.

CRM dùng lại **đúng các contract Platform đang có** (launcher + authorize + token-exchange +
session-check + JWKS, và khuôn chữ ký provisioning của TIMEKEEPING). Phần Platform cần bổ sung
được đánh dấu **[PLATFORM CẦN LÀM]**.

## 1. Catalog và installation

- **[PLATFORM CẦN LÀM]** Thêm `CUSTOMER_CARE_CRM` vào `PlatformProductCode` (migration enum additive)
  và vào catalog/Platform Admin UI (cấp/thu hồi/đổi gói theo tenant, cấp `UserProductAccess` theo user).
- Mỗi tenant có một `PlatformProductInstallation(productCode=CUSTOMER_CARE_CRM)`.
  `callbackBaseUrl = {CRM_PUBLIC_ORIGIN}/api/v1/crm` (production: `https://crm.vetclinic.vn/api/v1/crm`).
  Callback đầy đủ do Platform tạo: `{callbackBaseUrl}/auth/platform/callback?code=…&installation={clientId}&state=…`
  (khớp code `authorize` hiện tại).
- **Quan hệ với TenantProduct:** CRM là sản phẩm bổ trợ và có thể đi kèm B2B SALE hoặc PETCLINIC,
  giống TIMEKEEPING. **[PLATFORM CẦN QUYẾT ĐỊNH]** quy tắc đi kèm trong `platform-product-policy`.

## 2. Luồng đăng nhập (SSO)

```
Trình duyệt ── GET /api/v1/crm/auth/start ──▶ CRM: sinh state (32B), cookie HttpOnly SameSite=Lax 10'
          ◀── 302 {PLATFORM_WEB_ORIGIN}/product-launch/CUSTOMER_CARE_CRM?state=…
Trình duyệt ──▶ Platform launcher: đăng nhập Platform nếu cần → POST /api/platform-auth/authorize
                {productCode: CUSTOMER_CARE_CRM, state}  (kiểm tenant, TenantProduct, UserProductAccess,
                installation ACTIVE) → code một lần (~60s, lưu hash)
          ◀── 302 {callbackBaseUrl}/auth/platform/callback?code&installation&state
Trình duyệt ──▶ CRM callback: so state (constant-time) → tìm CrmTenant theo clientId (ACTIVE, callbackBaseUrl
                khớp) → POST {PLATFORM_API_BASE_URL}/platform-auth/token-exchange {code}
                headers x-installation-client-id / x-installation-client-secret (credential của tenant)
          ◀── JWT RS256 (kid/JWKS) → CRM kiểm iss, aud=CUSTOMER_CARE_CRM, exp, productCode, tenantId khớp
                installation, entitlementStatus ∈ {TRIAL, ACTIVE}, jti chưa dùng
          ◀── CRM tạo CrmSession (server-side, thu hồi được), cookie `__Host-vc_crm_session`
                (HttpOnly, Secure, SameSite=Lax, 8h) → 302 /#/tong-quan
Mọi request /api/v1/crm/*: tenant/user/roles lấy từ CrmSession; mỗi 60s gọi
                POST /platform-auth/session-check {platformUserId} → DENIED ⇒ thu hồi phiên ngay;
                lỗi mạng/5xx ⇒ chỉ dùng grace tới `graceUntil` của lần ACTIVE trước; hết grace ⇒ 503.
```

- **[PLATFORM CẦN LÀM]** Route launcher `/product-launch/CUSTOMER_CARE_CRM`. Nó phải giữ `state`
  qua màn đăng nhập, giống TIMEKEEPING, và allowlist `returnTo` tương ứng.
- **[PLATFORM NÊN LÀM]** Thêm claim `redirectUri` (callback đã ràng buộc với code) vào token-exchange
  JWT. Platform thật gửi `redirectUri = callbackBaseUrl` của installation (không phải URL callback
  đầy đủ); CRM chấp nhận đúng giá trị đó hoặc URL callback đầy đủ, ngoài ra `REDIRECT_MISMATCH`
  (lỗi này chỉ lộ ra khi chạy E2E thật 2026-09-24 và đã sửa).
- **[PLATFORM NÊN LÀM]** Claim vai trò riêng cho CRM là `crmRoles: ["CRM_OWNER"|"CRM_ADMIN"|"CRM_STAFF"|"CRM_VIEWER"]`
  trong cả token-exchange và snapshot session-check. Khi chưa có, CRM ánh xạ `ADMIN`/`TENANT_ADMIN`
  → `CRM_OWNER`, và vai trò khác → `CRM_STAFF`. Giá trị lạ → `CRM_VIEWER`, không bao giờ nâng quyền.
- **[PLATFORM NÊN LÀM]** Thêm `planCode`, `limits.dailyQuotaMax` vào claim hoặc sự kiện gói. Không có
  hạn mức gói thì CRM chỉ cho tenant *giảm* hạn mức ngày.
- Trang tài khoản Platform: CRM dẫn người dùng tới `{PLATFORM_WEB_ORIGIN}/account` để đổi mật khẩu.
  **[PLATFORM XÁC NHẬN]** đường dẫn này.

## 3. Sự kiện Platform → CRM (có chữ ký)

`POST {CRM_PUBLIC_ORIGIN}/api/v1/crm/platform/events`, dùng cùng khuôn provisioning TIMEKEEPING:

- `x-platform-provisioning-id`: UUID event (chống replay và idempotency).
- `x-platform-provisioning-timestamp`: Unix ms, lệch tối đa ±5 phút.
- `x-platform-provisioning-signature` = `hex(HMAC-SHA256(CRM_PLATFORM_EVENTS_SECRET, "${ts}.${eventId}.${sha256(rawBody)}"))`.
- Body: `{ version: 1, eventId, type | action, occurredAt, tenant: { platformTenantId, name }, entitlement?, installation?, user? }`.
- CRM kiểm chữ ký trên raw body **trước** khi đọc tenant. Cùng `eventId` gửi lại → `{duplicate:true}`,
  không có tác dụng lần hai. Sự kiện gói cũ hơn trạng thái hiện tại (`occurredAt`) → `IGNORED_STALE`.

| type (alias) | Tác dụng ở CRM |
|---|---|
| `installation.upserted` (`UPSERT_INSTALLATION`) | Lưu `clientId`, `clientSecret` (mã hóa AES-GCM, không bao giờ trả ra API), `callbackBaseUrl` (phải đúng bằng callback của CRM), gói. Gửi lại = xoay khóa. |
| `installation.revoked` (`REVOKE_INSTALLATION`) | Installation REVOKED, xóa secret, thu hồi mọi phiên tenant; worker hủy tác vụ đang chờ. |
| `subscription.activated` / `subscription.changed` | Cập nhật `entitlement.status/planCode/limits/features/startsAt/expiresAt`. |
| `subscription.suspended` | Thu hồi phiên; chặn tạo tác vụ mới; worker **giữ** tác vụ đang chờ. |
| `subscription.expired` | Thu hồi phiên; chặn tạo tác vụ mới; worker **hủy** tác vụ đang chờ. |
| `user_product_access.revoked` | Thu hồi phiên của đúng `user.platformUserId` trong tenant. |

**[PLATFORM CẦN LÀM]** Phát các sự kiện trên khi cấp/xoay/thu hồi installation, đổi trạng thái
`TenantProduct`, và thu hồi `UserProductAccess` của `CUSTOMER_CARE_CRM`. Cách làm giống
`TimekeepingProvisioningService`: ghi local trước, gửi sau; chỉ commit hash secret mới khi CRM trả 2xx.

### 3a. Nguồn PETCLINIC → CRM

Platform chuyển tiếp trạng thái nguồn PETCLINIC qua chính endpoint và cơ chế HMAC/chống replay ở
mục 3. `productCode` của sự kiện nguồn là `PETCLINIC_ESSENTIAL` (nguồn mới) hoặc
`PETCLINIC_OPERATING` (tương thích dữ liệu cũ); tenant phải đã tồn tại trong CRM. CRM không đọc
database PETCLINIC hay nhận tenant từ trình duyệt.

DTO bắt buộc:

```json
{
  "version": 1,
  "eventId": "uuid",
  "type": "petclinic_source.upserted",
  "occurredAt": "ISO-8601",
  "productCode": "PETCLINIC_ESSENTIAL",
  "tenant": { "platformTenantId": "uuid" },
  "source": {
    "sourceProduct": "PETCLINIC_ESSENTIAL",
    "installationId": "uuid",
    "revision": 1,
    "apiBaseUrl": "https://petclinic.example",
    "apiTenantId": "uuid",
    "allowedBranchIds": ["uuid"],
    "appointmentsPath": "/clinic-service/api/v1/clinic/appointments",
    "credential": { "keyId": "public-key-id", "token": "ONE_TIME_TOKEN" },
    "credentialExpiresAt": "ISO-8601"
  }
}
```

`status_changed` thêm `source.status`; `revoked` chỉ cần identity + revision; `upserted` và
`credential_rotated` cần origin/scope/credential đầy đủ. `revision` là số nguyên tăng đơn điệu theo
source installation. CRM từ chối contract version/identity sai; revision không tăng trả
`IGNORED_STALE`. Revoke vẫn thắng trạng thái hiện tại.

| type | Tác dụng ở CRM |
|---|---|
| `petclinic_source.upserted` | Tạo/cập nhật installation nguồn, origin API, phạm vi chi nhánh và Bearer credential dùng một lần. Snapshot cũ hơn `sourceUpdatedAt` bị bỏ qua. |
| `petclinic_source.credential_rotated` | Thay credential đã mã hóa. Như mọi sự kiện trừ `revoked`, `revision` phải **lớn hơn** revision đang lưu, nếu không CRM trả `IGNORED_STALE` và giữ credential cũ; vì vậy Platform tăng revision cho **mỗi** lần phát credential mới, kể cả lần thử lại sau mất ACK (đồng bộ 2026-09-25). |
| `petclinic_source.status_changed` | Đồng bộ ACTIVE/SUSPENDED/REVOKED; sự kiện cũ hơn trạng thái nguồn hiện tại bị bỏ qua. |
| `petclinic_source.revoked` | Xóa credential, đóng nguồn và hủy job đang QUEUED/PROCESSING của installation đó. Revoke luôn thắng. |

Payload nguồn tối thiểu: `source: { sourceProduct, apiBaseUrl, apiTenantId, allowedBranchIds,
credential:{ token, keyId }, credentialExpiresAt? }`. `apiTenantId` phải bằng tenant đã ký; URL production
phải là HTTPS origin thuần; token chỉ được mã hóa vào `PetclinicConnection`, không xuất hiện trong
`PlatformEvent`, audit hay phản hồi. CRM chỉ trả 2xx sau khi transaction chứa credential mã hóa đã
commit. Mỗi event lưu SHA-256 của raw payload: cùng `eventId` + đúng payload trả kết quả cũ với
`duplicate:true`; cùng `eventId` + payload khác trả 409 `EVENT_ID_REUSED`, kể cả khi gửi đồng thời.
Nếu Platform mất response chứa token thì không yêu cầu PETCLINIC phát lại token cũ: phải phát
`credential_rotated` với eventId/revision/token mới. Phản hồi 2xx có `result` bắt đầu bằng `IGNORED_`
(`IGNORED_STALE`, `IGNORED_UNKNOWN_TENANT`, …) nghĩa là CRM **không** lưu credential: Platform phải coi là
chưa giao và xoay khóa lại. Contract hợp nhất ba phía: `D:\petclinic-essential-crm-bridge\docs\integrations\crm-appointment-source-contract.md`. Rotation thay credential trong cùng transaction;
CRM không còn đường sử dụng credential cũ sau commit và PETCLINIC phải thu hồi credential cũ ngay.

Sync dùng `Authorization: Bearer …`, phân trang cho tới trang cuối
và không gửi `x-tenant-id`. Trước mỗi lần gửi, CRM gọi `POST {appointmentsPath}/:id/revalidate` với
`expectedAppointmentTime` + `expectedRevision`; mọi lỗi hoặc kết quả khác `eligible=true` và
`reasonCode=ELIGIBLE` đều không được phép gửi.

## 3b. Vòng đời chấm dứt / xóa tenant (dùng chung quy trình Platform, 2026-09-24)

CRM **không** có quy trình xóa riêng. Platform giữ `TenantDeletionRequest` (30 ngày) và gọi CRM qua
**cùng endpoint sự kiện** ở mục 3 (cùng HMAC, cùng chống replay ±5 phút). Không có endpoint
`/platform-provisioning/tenants/delete` cho CRM.

- **eventId cố định theo bước**: `crmLifecycleEventId(requestId, step)` (UUID v5-like từ sha256), nên
  Platform thử lại cùng bước luôn dùng cùng `eventId`; các bước khác nhau có `eventId` khác nhau.
- Body chung: `{ version:1, eventId, occurredAt, type, productCode:"CUSTOMER_CARE_CRM",
  tenant:{platformTenantId}, deletion:{ requestId, requestedAt, scheduledPurgeAt, retentionDays:30,
  exportRequired:true, requestedBy:"PLATFORM" } }`.
- Phản hồi mọi bước (kể cả gửi lại) mang trạng thái sổ xóa CRM, dạng `tenant.purge_status`:
  `{ accepted, eventId, result, duplicate?, requestId, platformTenantId, productCode, status:
  PENDING|PROCESSING|COMPLETED|FAILED|CANCELLED, completedAt, errorCode, errorMessage }`. Đây là kênh
  trả trạng thái đồng bộ; CRM không gọi ngược Platform.

| type | Tác dụng ở CRM |
|---|---|
| `tenant.deletion_requested` | Tạo `CrmTenantDeletion` PENDING; đặt `CrmTenant.deletionRequestId` (khóa: không đăng nhập mới, thu hồi mọi phiên, chặn tác vụ mới, worker **giữ** tác vụ chờ); trả `export` + `exportChecksum`. Không xóa gì. Gửi lại khi PENDING ⇒ trả lại bản xuất (đọc-chỉ). |
| `tenant.deletion_cancelled` | Sổ xóa → CANCELLED (chỉ khi chưa purge), gỡ khóa; quyền lấy **đúng** `entitlement` Platform gửi kèm (SUSPENDED vẫn đóng). Idempotent theo eventId và requestId. |
| `tenant.purge_requested` | Kiểm `requestId` thuộc đúng tenant, chưa hủy, đã tới `scheduledPurgeAt` (lệch ≤5'); nếu không ⇒ 409 `REQUEST_TENANT_MISMATCH` / `DELETION_NOT_REQUESTED` / `DELETION_CANCELLED` / `PURGE_NOT_DUE`. Xóa dữ liệu tenant trong một transaction; lỗi ⇒ rollback toàn bộ, sổ = FAILED, HTTP 503 `PURGE_FAILED` (lần gửi lại chạy thật lại). Thành công ⇒ COMPLETED + `deletedCounts`; gửi lại ⇒ cùng kết quả, không tác dụng lần hai. |

Bản xuất CRM (đưa vào `exportSnapshot.products.CUSTOMER_CARE_CRM` của Platform, có checksum riêng):
cấu hình tenant, người dùng/vai trò (từ phiên), installation (không secret), kết nối PETCLINIC (không
khóa), mẫu tin, khách/lịch chăm sóc (đã giải mã tên/SĐT), opt-out, tài khoản Zalo (chỉ SĐT che), luật
định tuyến, lịch sử gửi, nhật ký hoạt động (không metadata), sự kiện Platform. Loại trừ đệ quy mọi khóa
dạng secret/token/password/credential/hash/Enc; không có dữ liệu tenant khác hay cấu hình hệ thống.

Purge chỉ xóa bảng thuộc tenant (webhook/delivery, careJob, sender health, routing, zaloAccount,
opt-out, template, API credential, nonce, kết nối PETCLINIC, audit của tenant, installation, bộ đếm
quota, token replay, phiên, `CrmTenant`). Giữ lại: `PlatformEvent` (sổ idempotency), `CrmTenantDeletion`
(không PII), một dòng audit `TENANT_PURGED` không PII, `SystemSetting`, `AdminUser`, `ControlNonce`.

Phía Platform: khi tạo yêu cầu, gửi `tenant.deletion_requested` sau commit (lỗi ⇒ chỉ ghi trạng thái
chờ, worker lấy lại bản xuất trước khi purge); **không bao giờ purge CRM khi chưa có bản xuất CRM**;
chỉ coi CRM đã xóa khi phản hồi `status=COMPLETED` đúng `requestId`/tenant; khác đi ⇒ `PURGE_BLOCKED`,
ghi lỗi theo sản phẩm, lùi lịch thử lại; chỉ xóa `Tenant` + tạo biên nhận khi mọi sản phẩm COMPLETED.

## 3c. Giao nhận bền vững (outbox Platform, vòng 2 — 2026-09-24)

- Mọi sự kiện **không chứa secret** (`subscription.*`, `user_product_access.revoked`, `installation.revoked`,
  `tenant.deletion_requested`, `tenant.deletion_cancelled`) được Platform ghi vào bảng `CrmEventOutbox`
  **trong cùng transaction** với thay đổi nghiệp vụ, rồi gửi ngay sau commit; lỗi thì worker gửi lại.
  `id` của bản ghi = `eventId` gửi sang CRM, giữ nguyên qua mọi lần thử (lifecycle dùng
  `crmLifecycleEventId`). `occurredAt` chốt tại thời điểm đổi nghiệp vụ ⇒ CRM vẫn chặn được sự kiện cũ.
- `installation.upserted` (có client secret) **không** qua outbox: gửi trực tiếp, chỉ lưu hash sau 2xx.
  Outbox từ chối ghi mọi khóa dạng secret/password/token/credential.
- Thứ tự: trong một tenant, sự kiện chỉ được gửi khi mọi sự kiện cũ hơn đã DELIVERED/FAILED (khóa trước mở
  khóa; suspend trước activate). Không gộp/bỏ sự kiện: revoke/suspend không bao giờ bị nuốt; trạng thái
  cuối thắng vì được gửi sau cùng. Tenant khác độc lập.
- Lỗi mạng/5xx/429/408 ⇒ thử lại theo 1–5–15–60–180–720–1440 phút (sau đó mỗi ngày, bật cảnh báo);
  lỗi 4xx khác hoặc phản hồi không khớp requestId/tenant/productCode ⇒ `FAILED`, ghi audit, không tự gửi lại;
  Platform Admin bấm "Thử lại đồng bộ CRM" (`POST /api/platform/tenants/:id/crm-sync/retry`).
- Yêu cầu xóa: Platform khóa + ghi `tenant.deletion_requested` cùng transaction; trạng thái CRM trong yêu cầu:
  `LOCK_PENDING → RETRYING/LOCK_FAILED → LOCKED_EXPORT_READY`. Yêu cầu ở `EXPORT_PENDING` (chưa sẵn sàng,
  worker purge không nhận) tới khi CRM xác nhận khóa **và** Platform gộp bản xuất CRM (đúng một lần) + checksum.
- Hủy: Platform khôi phục quyền + ghi `tenant.deletion_cancelled` (kèm entitlement vừa khôi phục) cùng
  transaction ⇒ `CANCEL_PENDING` ("Đang chờ VETCLINIC CRM mở khóa"). Chỉ khi CRM trả `status=CANCELLED`
  (hoặc `IGNORED_UNKNOWN_REQUEST`: CRM chưa từng khóa) Platform mới chuyển `CANCELLED` và **xóa ngay**
  `exportSnapshot`, `exportPreparedAt`, checksum/marker bản xuất, ảnh chụp quyền. `GET deletion-export`
  sau đó trả **410**. CRM không lưu bản xuất; sổ xóa CRM chỉ giữ metadata + checksum.
- CRM: `tenant.deletion_cancelled` cũ hơn `entitlementUpdatedAt` chỉ gỡ khóa, không ghi đè entitlement mới
  (`result=APPLIED_LOCK_ONLY_STALE_ENTITLEMENT`).

## 4. Biến môi trường (chỉ tên, không có giá trị)

- **CRM:** `CRM_SESSION_SECRET` (≥32 ký tự, khác `ADMIN_SESSION_SECRET`), `CRM_PUBLIC_ORIGIN`,
  `PLATFORM_WEB_ORIGIN=https://admin.vetclinic.vn`, `PLATFORM_API_BASE_URL` (gồm `/api`), `PLATFORM_AUTH_ISSUER`,
  `PLATFORM_JWKS_URL` (tùy chọn), `CRM_PLATFORM_EVENTS_SECRET`, `CRM_SESSION_TTL_HOURS`,
  `CRM_ENTITLEMENT_RECHECK_SECONDS`, `PLATFORM_ALLOW_HTTP_LOCAL` (chỉ local).
- **Platform (đề xuất):** `CUSTOMER_CARE_CRM_CALLBACK_BASE_URL`, `CUSTOMER_CARE_CRM_EVENTS_URL`,
  `CUSTOMER_CARE_CRM_EVENTS_SHARED_SECRET` (cùng giá trị với `CRM_PLATFORM_EVENTS_SECRET`, riêng cho
  kênh này), `CUSTOMER_CARE_CRM_EVENTS_ALLOW_HTTP_LOCAL` (chỉ local), `CRM_EVENT_OUTBOX_WORKER_ENABLED`,
  `CRM_EVENT_OUTBOX_WORKER_INTERVAL_SECONDS` (5–3600, mặc định 30).

## 5. Nguồn công nợ B2B SALE (2026-09-24)

Khi `CUSTOMER_CARE_CRM` và `B2B_SALE` cùng `TRIAL|ACTIVE`, Platform tự provision nguồn
`B2B_SALE`; khách hàng không nhập token hoặc tenantId. `installation.upserted` mang thêm
`platformApiBaseUrl` và `source:{productCode:"B2B_SALE",status,startsAt,expiresAt}`. Mọi thay đổi gói
B2B sau đó dùng sự kiện có chữ ký `source.changed`; CRM tạo/cập nhật installation B2B tương ứng và
tạm dừng ngay khi nguồn không còn hiệu lực. Cùng `eventId` vẫn chống replay như mục 3.

CRM gọi B2B qua HTTPS bằng chính cặp `clientId/clientSecret` của installation CRM. B2B suy tenant
từ credential đã lưu; request không có và không được quyền chọn tenantId.

| API B2B | Kết quả |
|---|---|
| `GET /api/crm-b2b-source/receivables` | Các khoản còn phải thu, gồm external reference ổn định, khách hàng, SĐT E.164, số tiền, hạn, chứng từ, chi nhánh, updatedAt và consent. Chưa consent/phone sai vẫn trả `eligible:false`, CRM không được tạo việc. |
| `GET /api/crm-b2b-source/receivables/:externalReferenceId/revalidate` | Kiểm lại ngay trước gửi. ID sai/khác tenant/đã hết nợ đều trả cùng `{eligible:false,reason:"SOURCE_NO_LONGER_VALID"}` để không tạo oracle chéo tenant. |
| `PATCH /api/partners/:id/messaging-consent` | B2B tenant user có quyền cập nhật `GRANTED|WITHDRAWN`, nguồn, thời điểm, người ghi nhận; mặc định `UNKNOWN`. |

CRM cung cấp `GET /api/v1/crm/b2b-receivables` và
`POST /api/v1/crm/b2b-receivables/:externalReferenceId/queue`. Idempotency một lần nhắc/ngày dùng
`b2b-debt:{sourceId}:{YYYY-MM-DD}`. Worker luôn revalidate B2B trước khi chọn tài khoản/gửi; B2B lỗi,
mất quyền, hết nợ hoặc mất consent đều fail-closed. Không log credential, tên hay SĐT.
