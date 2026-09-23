# Contract Platform Admin ⇄ VETCLINIC CRM (`CUSTOMER_CARE_CRM`)

Trạng thái: **phía CRM đã triển khai và kiểm thử với Platform giả lập (local).** Phía Platform
**chưa có**, nên E2E với Platform thật là **BLOCKED**. Tài liệu này là handoff cho task
B2B & Platform Admin. CRM không tự sửa repo Platform.

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
  JWT. CRM đã kiểm claim này nếu có. Hiện CRM ràng buộc redirect bằng `callbackBaseUrl` đã được
  provision.
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

## 4. Biến môi trường (chỉ tên, không có giá trị)

- **CRM:** `CRM_SESSION_SECRET` (≥32 ký tự, khác `ADMIN_SESSION_SECRET`), `CRM_PUBLIC_ORIGIN`,
  `PLATFORM_WEB_ORIGIN`, `PLATFORM_API_BASE_URL` (gồm `/api`), `PLATFORM_AUTH_ISSUER`,
  `PLATFORM_JWKS_URL` (tùy chọn), `CRM_PLATFORM_EVENTS_SECRET`, `CRM_SESSION_TTL_HOURS`,
  `CRM_ENTITLEMENT_RECHECK_SECONDS`, `PLATFORM_ALLOW_HTTP_LOCAL` (chỉ local).
- **Platform (đề xuất):** `CUSTOMER_CARE_CRM_CALLBACK_BASE_URL`, `CUSTOMER_CARE_CRM_EVENTS_URL`,
  `CUSTOMER_CARE_CRM_EVENTS_SHARED_SECRET` (cùng giá trị với `CRM_PLATFORM_EVENTS_SECRET`, riêng cho
  kênh này), `CUSTOMER_CARE_CRM_EVENTS_ALLOW_HTTP_LOCAL` (chỉ local).
