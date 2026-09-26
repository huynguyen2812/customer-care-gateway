# Contract ĐỀ XUẤT: Platform Admin ↔ VETCLINIC CRM PC (Platform Device Agent v1)

> **Trạng thái (2026-09-26):** phía CRM PC khớp **contract chung** đã thống nhất giữa Codex và task B2B/Platform:
> `b2b-crm-pc-control-plane/docs/integrations/crm-pc-platform-contract.md` (nhánh `feat/crm-pc-control-plane`).
> Platform đã có counterpart **local** (`apps/api/src/platform-products/crm-pc-device.*`, chưa commit/deploy). PC mới kiểm thử
> bằng Platform giả lập mô phỏng đúng quy tắc lease/gia hạn của counterpart (`test/platform-device.integration.spec.ts`);
> **E2E HTTP với counterpart thật: NOT RUN** (xem báo cáo `qa-platform-lease-shared-contract-2026-09-26.md`).
> Khi hai bên lệch nhau, contract chung là nguồn chuẩn.

## 0. Nguyên tắc (anh Huy chốt 2026-09-26)

- **Platform chỉ là control plane.** Platform làm: cấp gói, mã kích hoạt một lần, quản lý thiết bị, cấp chi nhánh, hạn mức, trạng thái.
  CRM, PostgreSQL, worker, Sender và phiên Zalo chạy hoàn toàn trên PC.
- **PC luôn là bên gọi ra Platform qua HTTPS.** Platform **không** gọi vào localhost hay mạng LAN của khách.
- **Platform KHÔNG nhận, KHÔNG lưu, KHÔNG hiển thị:**
  - khóa API cục bộ (Client ID/Secret do CRM PC tự sinh để PETCLINIC/B2B ký HMAC);
  - dữ liệu khách, số điện thoại, nội dung tin, lịch hẹn, công nợ;
  - cookie/phiên Zalo;
  - khóa khôi phục.
- **Platform không ánh xạ từng lịch hẹn.** Platform chỉ cấp `allowedBranchIds` **theo từng nguồn** (PETCLINIC / B2B_SALE / EXTERNAL). CRM PC đọc lịch/công nợ trực tiếp từ nguồn bằng Source Connector v1.
- **Kích hoạt là bắt buộc để gửi tin (anh Huy chốt 2026-09-26).** Platform cấp mã kích hoạt cho từng khách. Bản phát hành chưa kích hoạt **không tạo lịch nhắc và không gửi tin** (`PLATFORM_ACTIVATION_REQUIRED`). Không có chế độ "chưa quản lý vẫn chạy".
- **Hai thứ khác nhau, không được nhầm:**

  | | Mã kích hoạt Platform | Khóa API cục bộ (Client ID/Secret) |
  |---|---|---|
  | Ai sinh | Platform Admin | CRM trên PC tự sinh |
  | Dùng để | Ghép PC với Platform một lần (cấp phép) | PETCLINIC/B2B ký HMAC khi gửi yêu cầu vào CRM PC |
  | Thời hạn | Dùng một lần, 10 phút | Dài hạn; xoay/thu hồi trên PC |
  | Platform có biết không | Có (lưu hash) | **Không bao giờ** |

## 1. Cấu hình phát hành (không lấy từ trình duyệt)

| Thành phần | Nơi đặt | Ghi chú |
|---|---|---|
| URL gốc API thiết bị | hằng số trong `packaging/windows/VetclinicCrm.psm1` → env `PLATFORM_DEVICE_API_URL` | Đề xuất `https://admin.vetclinic.vn/api/crm-pc/v1`. **Bắt buộc HTTPS**; http chỉ cho loopback khi có cờ `PLATFORM_DEVICE_ALLOW_INSECURE_LOCAL=1` (test/dev) |
| Khóa công khai ký cấu hình (Ed25519) | `packaging/windows/platform-config-keys.json` = `{"<keyId>":"<SPKI PEM>"}`, đi kèm bộ cài | Platform giữ khóa bí mật tương ứng. Nhiều `keyId` được phép (để xoay khóa). Thiếu file ⇒ PC không kích hoạt được, nên **không gửi được tin** |

## 2. Mã kích hoạt (Platform)

- **Sinh mã:** khi doanh nghiệp đã được cấp `CUSTOMER_CARE_CRM`. Mã dùng **một lần**, hiệu lực **10 phút**.
  Định dạng gợi ý `XXXX-XXXX-XXXX` (chữ hoa + số); PC chấp nhận `^[A-Z0-9]{4}(-?[A-Z0-9]{4}){1,5}$`.
- **Lưu trữ:** Platform chỉ lưu **hash** của mã.
- **Không phải** mật khẩu, không phải serial cố định, không phải API Secret.

## 3. Endpoint

### 3.1 `POST {base}/devices/redeem` (không có xác thực thiết bị; chứng minh bằng `proof`)

```json
{ "activationCode": "ABCD-EFGH-JKLM", "requestId": "<uuid>", "deviceId": "<uuid do PC sinh>",
  "devicePublicKey": "<SPKI PEM Ed25519>", "appVersion": "0.3.0-pc",
  "proof": "base64(Ed25519(devicePrivateKey, canonical))" }
```
`canonical = "VCPDA1\nREDEEM\n" + requestId + "\n" + deviceId + "\n" + activationCode + "\n" + devicePublicKey.trim()`

**Platform phải:**
- Kiểm `proof` bằng `devicePublicKey`.
- Tra mã theo hash, kiểm hạn, kiểm sản phẩm `CUSTOMER_CARE_CRM`, kiểm doanh nghiệp.
- Tạo đúng **một** thiết bị (deviceId + public key) và đánh dấu mã đã dùng, **trong cùng một giao dịch**.
- **Idempotent khi mất phản hồi (ACK):** cùng mã + cùng `deviceId` + cùng `devicePublicKey` thì trả lại **đúng kết quả cũ** (kể cả khi mã đã hết 10 phút). Không tạo thiết bị thứ hai.
- Cùng mã với thiết bị khác ⇒ `409 ACTIVATION_CODE_USED`.
- **PC giữ nguyên `deviceId` + `requestId` khi nhập lại đúng mã** sau lỗi mạng/mất ACK hoặc lỗi áp dụng cấu hình (mã khác ⇒ `requestId` mới). Platform nên coi (`activationCode`, `deviceId`, `requestId`) là khóa idempotent.
- **PC chỉ chuyển sang ACTIVE khi toàn bộ bước sau thành công trong một giao dịch DB:** xác minh phản hồi, lưu cấu hình ký, áp hạn mức/giờ yên tĩnh/gói/phạm vi nguồn, đặt ACTIVE, xóa request đang chờ, ghi revision. Lỗi bất kỳ ⇒ rollback toàn bộ, PC vẫn PENDING và có thể thử lại. Vì vậy Platform có thể đã đánh dấu mã "đã dùng" cho thiết bị này trong khi PC chưa ACTIVE — đó là trạng thái hợp lệ; lần thử lại sẽ nhận lại đúng kết quả.

**200:**
```json
{ "deviceId": "<uuid>", "platformInstallationId": "<id>", "config": { "payload": "...", "signature": "...", "keyId": "..." } }
```

**Lỗi** `{ "code": "..." }`:

| HTTP | code |
|---|---|
| 403 | `ACTIVATION_CODE_INVALID` |
| 403 | `ACTIVATION_CODE_EXPIRED` |
| 403 | `ACTIVATION_WRONG_PRODUCT` |
| 403 | `ACTIVATION_WRONG_TENANT` |
| 403 | `PLAN_NOT_ACTIVE` |
| 409 | `ACTIVATION_CODE_USED` |
| 401 | `DEVICE_PROOF_INVALID` |

### 3.2 Yêu cầu đã xác thực bằng khóa thiết bị (`sync`, `unpair`)

Header:

| Header | Giá trị |
|---|---|
| `x-vc-device-id` | deviceId |
| `x-vc-timestamp` | Unix ms |
| `x-vc-nonce` | chuỗi ngẫu nhiên |
| `x-vc-signature` | base64(Ed25519(devicePrivateKey, canonical)) |

`canonical = "VCPDA1\n" + METHOD + "\n" + PATH + "\n" + timestamp + "\n" + nonce + "\n" + hex(SHA256(rawBody))`

Platform kiểm:
- chữ ký, bằng public key đã đăng ký cho deviceId;
- độ lệch giờ tối đa ±300 giây;
- nonce không được lặp trong 10 phút.

**Tenant/thiết bị luôn lấy từ thiết bị đã xác thực, không lấy từ body.**

**`POST {base}/devices/{deviceId}/sync`**, body:
```json
{ "currentRevision": 3,
  "heartbeat": { "deviceId": "...", "appVersion": "0.3.0-pc", "buildCommit": "abc1234",
    "services": { "api": "UP", "worker": "UP", "sender": "UP|DOWN|UNKNOWN", "source": "OK|FAILED|NOT_CONFIGURED|DRY_RUN|UNKNOWN" },
    "lastSourceSyncAt": "ISO|null",
    "queue": { "queued": 0, "processing": 0, "sent24h": 0, "failed24h": 0, "deliveryUncertain": 0 },
    "errorCodes": ["SOURCE_VERIFY_UNAVAILABLE"] } }
```
- **200:** `{ "deviceStatus": "ACTIVE" | "REVOKED", "config"?: SignedConfig }`. Chỉ gửi `config` khi có revision mới hơn `currentRevision`.
- **Lịch sync của PC:** mặc định 60 giây, tối đa 2 phút (`PLATFORM_SYNC_INTERVAL_SECONDS`, bị kẹp 15–120 giây); lần đầu 10 giây sau khi worker khởi động. PC **không** tự yêu cầu cấu hình mới; Platform quyết định thời điểm phát revision gia hạn (mục 4.1).
- HTTP 200, heartbeat ACK, phản hồi không có `config`, hay gửi lại đúng revision cũ (cùng byte/envelope) **không** kéo dài quyền gửi trên PC.
- **Thu hồi:** chỉ khi endpoint Platform đã cấu hình trả **đúng** `403 {"code":"DEVICE_REVOKED"}` (hoặc `deviceStatus: "REVOKED"` / cấu hình ký có `deviceStatus: REVOKED`) thì PC chuyển REVOKED và dừng gửi. `401 DEVICE_UNKNOWN`, 403 mã khác hoặc không có mã, lỗi 5xx, lỗi mạng ⇒ chỉ ghi `lastSyncError`, **không** coi là thu hồi và **không** gia hạn. PC đang mất mạng không thể bị thu hồi tức thời; nó chỉ dùng được giấy phép ký gần nhất tới hạn của chính giấy phép đó.

**`POST {base}/devices/{deviceId}/unpair`** ⇒ 200. Platform đánh dấu thiết bị UNPAIRED.

Heartbeat **chỉ có** các trường trên. Test tự động kiểm không có tên khách, SĐT, nội dung, clientId/secret, private key, tenantId cục bộ.

## 4. SignedConfig

`payload = base64url(bytes JSON)`, `signature = base64(Ed25519(configSigningKey, payload bytes))`.
Chữ ký phủ **đúng các byte** đó; PC không chuẩn hóa lại JSON.

```json
{ "v": 1, "type": "CRM_PC_CONFIG", "productCode": "CUSTOMER_CARE_CRM",
  "revision": 4, "issuedAt": "ISO", "expiresAt": "ISO",
  "deviceId": "<uuid>", "deviceStatus": "ACTIVE|REVOKED", "platformInstallationId": "<id>",
  "tenant": { "id": "<platform tenant id>", "name": "Phòng khám ABC" },
  "plan": { "code": "CRM_PC_BASIC", "status": "ACTIVE|TRIAL|SUSPENDED|EXPIRED|TERMINATED", "validFrom": "ISO|null", "validUntil": "ISO|null" },
  "sources": [ { "product": "PETCLINIC", "allowedBranchIds": ["CN1"], "maxBranches": 3 },
               { "product": "B2B_SALE", "allowedBranchIds": ["KHO-HCM"], "maxBranches": 1 } ],
  "features": { "appointmentReminder": true, "debtReminder": false },
  "limits": { "dailyQuota": 60 },
  "reminderLeadMinutes": 1440,
  "quietHours": { "start": "21:00", "end": "08:00", "timezone": "Asia/Ho_Chi_Minh" },
  "offlineGraceHours": 72 }
```

**PC chấp nhận khi:**
- `keyId` có trong danh sách khóa phát hành và chữ ký đúng;
- `deviceId` đúng máy này; đúng `type` và `productCode`;
- `issuedAt` không quá hiện tại + 5 phút; `expiresAt` còn hạn;
- lease hợp lệ: `0 < expiresAt − issuedAt ≤ max(5 phút, offlineGraceHours giờ)` (dung sai 1 giây). Lease dài hơn ⇒ **từ chối** (`CONFIG_LEASE_INVALID`), không tự cắt;
- `offlineGraceHours` là **số nguyên 0–72, bắt buộc**. Thiếu, `null`, chuỗi, số âm, số lẻ, lớn hơn 72 ⇒ **từ chối cả cấu hình** (không tự điền mặc định, không tự cắt về 72). `0` được giữ đúng là `0`;
- các trường hợp lệ; `sources[].product` thuộc `PETCLINIC | B2B_SALE | EXTERNAL`, **mỗi product tối đa một mục** (trùng ⇒ từ chối cả cấu hình).

**Revision:**
- Phải **tăng đơn điệu** theo thiết bị.
- Revision **thấp hơn** revision đã áp dụng ⇒ từ chối (chống hạ cấp).
- **Trùng revision, cùng nội dung** ⇒ bỏ qua (idempotent, xử lý trường hợp mất ACK).
- **Trùng revision, khác nội dung** ⇒ từ chối.

### 4.1 Thời hạn quyền gửi (contract chung)

**Platform ký** (PC không tự tính thêm):

```
expiresAt = min( issuedAt + max(5 phút, offlineGraceHours × 60 phút),
                 hạn gói CRM (nếu có), hạn gói nguồn liên quan (nếu có) )
```

**PC thực thi** trước khi tạo tin và ngay trước khi gửi (kể cả worker): chỉ được gửi **trước** mốc sớm hơn giữa `expiresAt` và `plan.validUntil` của cấu hình ký mới nhất. Đúng bằng mốc hoặc sau ⇒ chặn, tin được **giữ** (HOLD), không xóa dữ liệu hay phiên Zalo.

| Mốc | Mã khi hết |
|---|---|
| `plan.validUntil` | `PLAN_EXPIRED` |
| `expiresAt` | `PLATFORM_CONFIG_EXPIRED` |

- PC **không** cộng 60 phút, 72 giờ hay bất kỳ thời gian nào; `offlineGraceHours` chỉ là đầu vào của công thức phía Platform và dùng để PC kiểm lease không dài quá mức.
- **`offlineGraceHours = 0`:** lease online 5 phút (vẫn bị giới hạn bởi hạn gói); PC sync ≤ 2 phút; mất kết nối thì chỉ dùng tới `expiresAt`, không có thời gian cộng thêm.
- **Gia hạn (Platform quyết định):** `renewWindow = min(24 giờ, (expiresAt − issuedAt) / 3)` tính trên **envelope đang lưu**. Khi `now ≥ expiresAt − renewWindow`, Platform phát **revision mới** nếu quyền còn hiệu lực, `expiresAt` mới muộn hơn và không vượt hạn gói. Ví dụ grace 0 cấp tại t0: hạn t0+5 phút; sync t0+2 phút không có cấu hình mới; từ t0+3 phút 20 giây có thể nhận revision mới.
- Cùng revision luôn là **cùng envelope** (không ký lại); gửi lại không gia hạn. Cấu hình sai chữ ký, sai thiết bị, revision cũ, cùng revision khác nội dung, lease quá dài ⇒ bị từ chối, không gia hạn. Retry sau mất ACK vẫn idempotent.
- **Denial config:** khi gói hết hạn/tạm dừng, Platform phát revision mới có `plan.status = EXPIRED/SUSPENDED`, `expiresAt` ở tương lai; `plan.validUntil` có thể đã qua — PC vẫn xác minh và áp dụng, rồi chặn ngay (`PLAN_EXPIRED` / `PLAN_SUSPENDED`).
- Khi có revision mới hợp lệ, tin đang giữ tiếp tục được xử lý; tin trễ quá 12 giờ so với giờ hẹn gửi vẫn bị hủy (`EXPIRED_WHILE_OFFLINE`).

## 5. PC thực thi (đã hiện thực)

| Tình huống | Hành vi |
|---|---|
| Chưa kích hoạt (chưa có đăng ký, hoặc chỉ có lần thử PENDING) | `PLATFORM_ACTIVATION_REQUIRED`: **không tạo lịch nhắc, không gửi tin**; tin đã có trong hàng đợi được giữ (HOLD). Vẫn làm được: thiết lập/đăng nhập, tài khoản nhân viên, tạo/xoay/thu hồi Client ID/Secret cục bộ, cấu hình và xem trước nguồn, sao lưu/khôi phục, nhập mã kích hoạt, xem trạng thái |
| ACTIVE, gói ACTIVE/TRIAL, trước thời hạn quyền gửi (mục 4.1) | Chạy theo phạm vi đã ký |
| Mất Internet / Platform không phản hồi | Chạy theo cấu hình ký gần nhất tới `expiresAt`/`plan.validUntil` của chính nó; không có gì được gia hạn cho tới khi nhận revision mới |
| Hết thời hạn mục 4.1 (`PLAN_EXPIRED` / `PLATFORM_CONFIG_EXPIRED`) / gói SUSPENDED, EXPIRED, TERMINATED, chưa tới ngày bắt đầu / thiết bị REVOKED / UNPAIRED / khóa thiết bị không mở được (khôi phục sang máy khác) | Không tạo tin mới, không gửi tin chưa bắt đầu (tin **được giữ lại**, không xóa). Đăng nhập, xem lịch sử, cấu hình nguồn, sao lưu và nhập mã vẫn làm được. Có ghi nhật ký |
| Phạm vi nguồn/chi nhánh | Kiểm theo `{ sourceProduct, branchId, eventType }` với **đúng mục nguồn** của tin, không lấy hợp các nguồn. Ánh xạ: `PETCLINIC_OPERATING`/`PETCLINIC_ESSENTIAL` ⇒ `PETCLINIC`; `B2B_SALE` ⇒ `B2B_SALE`; `EXTERNAL_CONNECTOR` ⇒ loại do chủ doanh nghiệp chọn rõ ở kết nối nguồn (`SourceConnection.sourceKind`), không đoán theo chi nhánh. Nguồn được ghi lên từng tin (`CareJob.licenseSource`) khi tạo |
| Nguồn không được cấp / chi nhánh ngoài danh sách của nguồn đó / thiếu chi nhánh / tính năng chưa cấp / đổi loại nguồn | Từ chối khi tạo tin; khi gửi thì **hủy** tin: `SOURCE_NOT_LICENSED` / `BRANCH_NOT_LICENSED` / `BRANCH_REQUIRED` / `FEATURE_NOT_LICENSED` / `SOURCE_KIND_CHANGED`. Chưa chọn loại nguồn ⇒ `SOURCE_SCOPE_REQUIRED` (giữ tin, không hủy). Platform thu hẹp chi nhánh ⇒ tin chưa gửi ngoài phạm vi mới bị hủy ở lần kiểm tra ngay trước khi gửi |
| Áp dụng cấu hình | `Installation.dailyQuota`, giờ yên tĩnh, `reminderLeadMinutes` lấy theo cấu hình; danh sách chi nhánh cục bộ chỉ được **thu hẹp** (giao với danh sách được cấp **cho đúng loại nguồn của kết nối**); tính năng chỉ được tắt bớt |
| Sau khi đã từng ghép | Không bao giờ quay về trạng thái "chưa kích hoạt" hay bỏ qua giấy phép (`everPaired`), kể cả khi đang kích hoạt lại |
| Cờ kiểm thử `PLATFORM_LICENSE_BYPASS=1` | Chỉ có hiệu lực khi `NODE_ENV` ≠ `production` **và** máy chưa từng ghép. Dịch vụ Windows luôn chạy `NODE_ENV=production`; bộ cài không bao giờ ghi cờ này; không request/trình duyệt nào bật được. Khi bật, màn Kết nối Platform và `local-status` cảnh báo đỏ |

## 6. Khóa và dữ liệu trên PC

- **Khóa thiết bị:** Ed25519 do PC sinh.
  - Khóa bí mật được mã hóa AES-256-GCM bằng `DEVICE_KEY_ENC_KEY`. Khóa này chỉ có trên máy (DPAPI + ACL) và **không nằm trong gói khóa của bản sao lưu**.
  - Khôi phục sang máy khác ⇒ `DEVICE_REPAIR_REQUIRED` ⇒ phải ghép lại bằng mã mới.
- **Bảng dữ liệu** (migration `0014_platform_device_agent` + `0015_platform_scope_and_activation`):
  - `PlatformDeviceRegistration`: hiện chỉ 1 dòng; `deviceId` unique để sau này hỗ trợ nhiều thiết bị.
  - `PlatformDesiredConfiguration`: chỉ lưu cấu hình đã xác minh; unique theo (deviceId, revision).
  - `0015`: `PlatformDeviceRegistration.activationLockedUntil` (khóa ngắn, mỗi lúc một lần kích hoạt), `pendingCodeHash` (HMAC bằng khóa máy của mã đang kích hoạt, chỉ để nhận ra lần thử lại cùng mã; xóa khi ACTIVE), `everPaired`; `SourceConnection.sourceKind`; `CareJob.licenseSource`.
  - **Không bảng nào** chứa mã kích hoạt (dạng rõ), khóa API cục bộ, phiên Zalo hay khóa khôi phục.

## 7. Việc Platform (task B2B) cần làm

1. Chốt URL, tên endpoint và mã lỗi (có thể dùng nguyên bản đề xuất này).
2. Bảng thiết bị (deviceId, public key, trạng thái, installationId, tenant), mã kích hoạt (lưu hash, hết hạn, dùng một lần), nonce.
3. UI Platform Admin:
   - sinh mã kích hoạt 10 phút;
   - xem thiết bị và heartbeat tổng hợp;
   - thu hồi thiết bị;
   - cấp chi nhánh **riêng cho từng nguồn** (PETCLINIC / B2B_SALE / EXTERNAL), hạn mức, tính năng, giờ yên tĩnh, thời gian nhắc;
   - mỗi thay đổi tạo một revision mới.
   - lease và gia hạn đúng mục 4.1 (đã có trong counterpart local `crm-pc-device.service.ts`);
   - `offlineGraceHours` luôn là số nguyên 0–72 (mặc định 72).
4. Khóa ký cấu hình Ed25519: lưu trong secret store của Platform, xoay theo `keyId`. Giao khóa công khai cho CRM PC để đóng gói (`platform-config-keys.json`).
5. Test E2E thật giữa Platform và PC trên staging trước khi phát hành.

## 8. Kích hoạt chưa hoàn tất (PENDING) và phục hồi (2026-09-26)

Khớp contract chung mục 1 và 7 (`b2b-crm-pc-control-plane/docs/integrations/crm-pc-platform-contract.md`).

**Trạng thái PC khi đang chờ** (`GET /api/v1/crm/local/platform` → `activation`):

| `activation.state` | Ý nghĩa | Việc người dùng làm được |
|---|---|---|
| `NOT_BOUND` | Platform đã từ chối rõ ràng trước khi ghép (mã sai, mã đã dùng ở máy khác, sai sản phẩm, gói chưa hiệu lực…) | Nhập mã khác (giữ nguyên danh tính thiết bị vì Platform chưa ghép) |
| `RETRY_SAME_CODE` | Lần trước có thể đã ghép trên Platform (mất phản hồi, lỗi 5xx, hoặc Platform trả lời nhưng PC không lưu được) | Chỉ nhập lại **đúng mã đó** (giữ nguyên `requestId`/`deviceId`/khóa) trước hạn gốc 10 phút. Mã khác ⇒ `409 ACTIVATION_RETRY_SAME_CODE`, không gọi Platform |
| `RECOVERY_REQUIRED` | Platform báo `ACTIVATION_CODE_EXPIRED` hoặc `DEVICE_REVOKED` cho lần kích hoạt có thể đã ghép | Không thử lại được nữa (`409 ACTIVATION_RECOVERY_REQUIRED`, không gọi Platform) ⇒ làm quy trình phục hồi |
| `IN_PROGRESS` | Đang có thao tác kích hoạt/phục hồi giữ khóa ngắn (2 phút) | Đợi |

- PC **không lưu mã kích hoạt dạng rõ**; chỉ giữ HMAC (khóa máy) để nhận ra lần nhập lại cùng mã. Người dùng phải nhập lại mã.
- Timeout hay lỗi mạng **không bao giờ** tự xóa ghép nối, đổi khóa, tạo thiết bị mới hay coi là thu hồi.
- Chỉ **thiết bị ACTIVE** mới hiển thị/đọc được giấy phép và thời hạn gửi; PENDING/UNPAIRED/REVOKED luôn chặn tạo và gửi tin.

**Phục hồi có xác nhận:** `POST /api/v1/crm/local/platform/unpair`, body `{"confirm":"NGAT GHEP NOI"}`, chỉ vai trò có `crm.users.manage` (chủ doanh nghiệp). Dùng được cho ACTIVE và PENDING. Thao tác giữ cùng khóa ngắn với kích hoạt, nên kích hoạt và phục hồi không bao giờ chạy đồng thời (`409 ACTIVATION_IN_PROGRESS`). Kết quả báo **hai việc tách riêng**:

```json
{ "reset": { "local": "UNPAIRED", "platform": "PLATFORM_UNPAIRED | PLATFORM_ALREADY_REVOKED | PLATFORM_DEVICE_UNKNOWN | PLATFORM_NOT_CONFIRMED" } }
```

- **A — trên máy (luôn làm):** trạng thái `UNPAIRED`; lần kích hoạt sau dùng `deviceId`/khóa **mới**. Không xóa khách hàng, nguồn, lịch sử, mẫu tin, phiên Zalo hay Client ID/Secret cục bộ; gửi tin vẫn dừng.
- **B — trên Platform (chỉ báo đúng câu Platform trả lời):** PC gọi `POST /devices/{deviceId}/unpair` có ký. `200` ⇒ `PLATFORM_UNPAIRED`; `403 DEVICE_REVOKED` ⇒ `PLATFORM_ALREADY_REVOKED`; `401 DEVICE_UNKNOWN` ⇒ `PLATFORM_DEVICE_UNKNOWN` (lần kích hoạt chưa tới Platform); mọi trường hợp khác ⇒ `PLATFORM_NOT_CONFIRMED`. A thành công **không** có nghĩa B thành công.

**Quy trình khi mã đã quá 10 phút** (khớp contract chung mục 7):
1. Quản trị Platform thu hồi đúng hồ sơ thiết bị treo (đối chiếu mã thiết bị dạng `xxxx…yyyy` mà PC hiển thị). PC **không** làm thay được việc này.
2. Chủ doanh nghiệp bấm "Xóa trạng thái ghép nối trên máy này" và xác nhận (A; B sẽ báo `PLATFORM_ALREADY_REVOKED`).
3. Quản trị Platform tạo mã mới; nhập trên PC ⇒ thiết bị mới. Hồ sơ cũ giữ REVOKED, không hồi sinh.

## 9. Mã chi nhánh trên đường truyền (khớp contract chung mục 6)

- Với nguồn `PETCLINIC` và `B2B_SALE`, `branchId` trên đường truyền (Source Connector, API tạo job, cấu hình) phải là **UUID chi nhánh Platform**. Cầu PETCLINIC hiện hữu đã ánh xạ mã nội bộ (vd. `812`) sang UUID qua `platform_branch_mappings`; PC **không** đổi ngược về số nội bộ.
- Mã không phải UUID ⇒ chặn với lý do rõ `BRANCH_MAPPING_REQUIRED` (khi tạo tin, khi lưu kết nối, trong xem trước lịch/công nợ, và kiểm lại trước khi gửi). Không bỏ kiểm quyền.
- Connector `EXTERNAL` hoặc connector có namespace khác **không** được coi là tương thích mặc định; Platform hiện không cấp mục `EXTERNAL` nên luôn `SOURCE_NOT_LICENSED`. Cần adapter/mapping riêng trước khi dùng.
