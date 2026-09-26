# VETCLINIC Source Connector v1 (bản chạy trên PC)

Đặc tả để hệ thống của doanh nghiệp (phần mềm phòng khám, bán hàng…) cho VETCLINIC CRM đọc lịch hẹn / công nợ.
Mẫu theo connector PETCLINIC và B2B hiện có: CRM đọc theo trang, mặc định chỉ xem trước (dry-run), tạo tác vụ
idempotent, và **hỏi lại nguồn ngay trước khi gửi**. Nguồn không phản hồi hoặc trả lời sai định dạng thì **không gửi**.

CRM không truy cập database của hệ thống nguồn; mọi dữ liệu đi qua HTTP API dưới đây.

## 1. Xác thực (cả hai chiều dùng cùng một khóa API tự sinh)

Khóa API gồm `clientId` + `clientSecret`. Nó được tạo khi thiết lập CRM lần đầu (hoặc trong mục "Tài khoản & kết nối"),
và mã bí mật chỉ hiện một lần. Cả hai bên dùng `signingKey = hex(SHA-256(clientSecret))`.

### 1a. CRM → hệ thống nguồn (connector)

Mỗi request CRM gửi kèm các header sau:

| Header | Giá trị |
|---|---|
| `x-care-client-id` | clientId |
| `x-care-timestamp` | Unix milliseconds; nguồn nên từ chối nếu lệch quá 300 giây |
| `x-care-nonce` | chuỗi ngẫu nhiên; nguồn nên từ chối nonce đã thấy trong 10 phút |
| `x-care-signature` | hex HMAC-SHA256(signingKey, canonical) |

```
canonical = "VCSC1\n" + METHOD + "\n" + PATH_AND_QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA-256(rawBody))
```

- `PATH_AND_QUERY`: đường dẫn kèm query string, đúng như trên dòng request (ví dụ `/connector/v1/appointments?from=…&page=0&size=500`).
- Tiền tố `VCSC1` tách miền chữ ký: một request CRM gửi đi không thể bị phát lại thành request hợp lệ vào API care-job của CRM.
- CRM không đi theo redirect, timeout 10 giây, từ chối phản hồi lớn hơn 5 MB.
- Địa chỉ nguồn chấp nhận: HTTPS, hoặc `http://127.0.0.1` / `http://localhost` (nguồn chạy trên cùng máy). Muốn dùng
  `http://` trong LAN nội bộ (10.x, 172.16–31.x, 192.168.x) phải bật rõ `STANDALONE_ALLOW_HTTP_LAN_SOURCES=true`
  (không khuyến nghị). URL không được chứa user/password.

### 1b. Hệ thống ngoài → CRM (API care-job trong máy/LAN)

Giữ nguyên hợp đồng installation API hiện có (`docs/api-contract.md`):
`x-care-signature = hex HMAC-SHA256(signingKey, METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(rawBody))`, gọi vào
`POST /api/v1/care-jobs`, `GET /api/v1/care-jobs/:id`, `POST /api/v1/care-jobs/:id/cancel`, `POST /api/v1/opt-outs`.
Doanh nghiệp (tenant) được suy ra từ credential; trường `tenantId` trong body, nếu có, phải trùng, nếu khác thì trả 403.
`sourceProduct` phải là `EXTERNAL_CONNECTOR`.

Tác vụ gửi vào bằng API vẫn phải qua bước kiểm tra lại trước khi gửi. Vì vậy `externalReferenceId` phải có dạng
`appointment:<id>` (kèm `sourceAppointmentAt`, `sourceRevision`) hoặc `receivable:<id>` (kèm `sourceRevision`), và
connector đọc ở mục 2 phải được cấu hình và bật. Nếu không đủ các điều kiện này thì tác vụ bị hủy, không gửi (fail closed).

### Xoay / thu hồi khóa

- **Tạo khóa mới:** khóa cũ chuyển sang `ROTATING_OUT` và còn hiệu lực thêm 24 giờ. CRM ký request đi bằng khóa mới
  nhất, nên hệ thống nguồn cần chấp nhận cả hai khóa trong 24 giờ đó.
- **Thu hồi:** khóa mất hiệu lực ngay, cho cả hai chiều.

## 2. Endpoint hệ thống nguồn phải cung cấp (tương đối so với `apiBaseUrl`)

### `GET appointments?from=<ISO>&to=<ISO>&page=<n>&size=<n>`

```json
{ "data": { "items": [ {
  "id": "A123", "appointmentAt": "2026-10-01T02:00:00Z", "status": "SCHEDULED", "revision": "7",
  "branchId": "CN1", "customer": { "name": "Nguyễn Văn A", "phone": "0901234567" },
  "pet": { "name": "Mướp" }, "serviceName": "Tiêm phòng",
  "consent": { "status": "DEFAULT_ALLOWED", "channel": "ZALO", "purpose": "APPOINTMENT_REMINDER" }
} ], "page": 0, "totalPages": 1, "last": true } }
```

- `id`: `[A-Za-z0-9._:-]{1,120}`. Mỗi lần lịch hẹn thay đổi thì `revision` phải đổi theo.
- CRM chỉ tạo nhắc lịch khi `status` ∈ `SCHEDULED | CONFIRMED` và chi nhánh nằm trong danh sách được duyệt.

### `POST appointments/{id}/revalidate`, body `{ "expectedAppointmentTime": ISO, "expectedRevision": "7" }`

Trả `{ "data": { "appointmentId": "A123", "eligible": true, "reasonCode": "ELIGIBLE" } }`. CRM chỉ gửi khi đúng
`eligible=true` và `reasonCode=ELIGIBLE` cho cùng id. Lịch đã đổi giờ, đổi revision, bị hủy hoặc khách rút đồng ý
thì trả `eligible=false`.

### `GET receivables?page=&size=` và `POST receivables/{id}/revalidate` (body `{ "expectedRevision" }`)

Mỗi item có `{ id, documentCode, customer{name,phone}, remainingAmount, dueAt, branchId, revision, consent }`.
Kết quả revalidate trả `{ data: { receivableId, eligible, reasonCode: "ELIGIBLE", remainingAmount } }`. CRM chỉ
gửi khi `remainingAmount > 0`. Mỗi chứng từ tối đa một tin nhắc mỗi ngày.

## 3. Chính sách đồng ý (consent)

| Mục đích | Chấp nhận | Luôn chặn |
|---|---|---|
| Nhắc lịch hẹn qua Zalo (`channel` = ZALO hoặc trống, `purpose` = APPOINTMENT_REMINDER hoặc trống) | `GRANTED`, `DEFAULT_ALLOWED` | `REVOKED`, `WITHDRAWN`, `OPTED_OUT`; không có `consent` |
| Nhắc công nợ | chỉ `GRANTED` | mọi giá trị khác, kể cả `DEFAULT_ALLOWED` |
| Kênh khác (SMS…) hoặc mục đích khác (marketing…) | không áp dụng mặc định | — |

CRM không tạo ô bắt chủ nuôi đồng ý nhận nhắc lịch. Mặc định "được phép" do hệ thống nguồn báo (`DEFAULT_ALLOWED`).

## 4. Không gửi dồn tin quá hạn

Worker hủy (mã `EXPIRED_WHILE_OFFLINE`, có ghi nhật ký) mọi tin trễ **hơn 12 giờ** so với giờ gửi dự kiến, ví dụ
khi máy tắt, mất mạng hoặc đang tạm dừng lâu. Tin trễ dưới 12 giờ vẫn được gửi, kể cả khi lịch hẹn đã qua, để khách
có thể hẹn lại. Có thể chỉnh ngưỡng bằng `CARE_JOB_MAX_LATENESS_HOURS`. Tin đã có lần gửi "chưa rõ kết quả"
(UNKNOWN) vẫn giữ quy tắc cũ: không tự gửi lại.
