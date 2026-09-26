# VETCLINIC CRM — đóng gói bản chạy trên PC (Windows)

| Việc | Lệnh |
|---|---|
| **Phát hành** (build + bộ cài .exe + gói cập nhật + manifest ký) | `release.ps1 -ToolsCache … -CrmRepo … -SenderRepo … -OutDir … -SigningKey <private.pem> -BaseUrl https://<web>/crm-pc -Iscc <ISCC.exe> -Version 0.3.0-pc` |
| Build tái lập (không cần quyền admin) | `build.ps1 -ToolsCache <tools-cache> -CrmRepo <crm> -SenderRepo <sender> -OutDir <build>` |
| Khách cài | chạy `VETCLINIC-CRM-Setup-<ver>.exe` (im lặng: `/VERYSILENT /RECOVERYOUT="<file>"`, lỗi ⇒ mã 10) |
| Cài bằng script (kỹ thuật) | `install.ps1 -StageDir <stage>` [`-RestoreFrom <file.vcbak> -RecoveryKeyFile <file>`] |
| Gỡ, giữ dữ liệu | "Apps & features" / `unins000.exe`, hoặc `uninstall.ps1` |
| Gỡ và xóa dữ liệu | `uninstall.ps1 -DeleteData -ConfirmText "XOA TOAN BO DU LIEU"` (chỉ khi đã có backup + khóa khôi phục) |
| Sao lưu / kiểm tra / thử khôi phục | `backup.ps1` / `-Verify <file>` / `-TestRestore <file>` |
| Cập nhật | tự động (`check-update.ps1`, cần `settings.json → updateManifestUrl`), hoặc chạy `.exe` bản mới, hoặc `update.ps1 -Package <zip>` |
| Khởi động lại dịch vụ | `restart-services.ps1 [-StopDbToo]` |
| Hỗ trợ | `diag.ps1` (gói chẩn đoán không secret/PII), `tray.ps1 -StatusOnly` |
| Khóa ký cập nhật (một lần) | `node tools\vcupdate.mjs keygen <private.pem> update-public-key.pem` — private key để NGOÀI repo |

## Dịch vụ, cổng và thư mục

| Dịch vụ Windows | Chạy gì | Cổng (chỉ 127.0.0.1) | Tài khoản |
|---|---|---|---|
| `VetclinicCrmDb` | PostgreSQL 17 (bản zip) | 55432 | `NT AUTHORITY\NetworkService` |
| `VetclinicCrmApi` | CRM API + giao diện | 47100 | `NT SERVICE\VetclinicCrmApi` (tài khoản ảo) |
| `VetclinicCrmWorker` | hàng đợi gửi tin (không mở cổng) | — | `NT SERVICE\VetclinicCrmWorker` |
| `VetclinicCrmSender` | Zalo Sender, chế độ chỉ-sender (AGPL-3.0) | 47110 | `NT SERVICE\VetclinicCrmSender` |

Cả 4 dịch vụ khởi động tự động (Delayed Auto Start), phụ thuộc `VetclinicCrmDb`, và tự khởi động lại khi lỗi (sau 10 giây, rồi sau 60 giây).
Không cần Docker, Redis hay mở firewall.

| Thư mục | Nội dung | Quyền |
|---|---|---|
| `C:\Program Files\VETCLINIC CRM\app\<version>\` | node, crm, sender (+ LICENSE, NOTICE, sender-source.zip), pgsql, winsw, scripts | mặc định Program Files |
| `C:\Program Files\VETCLINIC CRM\services\` | WinSW `.exe` + `.xml` của từng dịch vụ | mặc định Program Files |
| `C:\ProgramData\VETCLINIC CRM\db` | dữ liệu PostgreSQL | SYSTEM, Administrators, NetworkService |
| `…\secrets\secrets.dpapi` | toàn bộ secret, bọc DPAPI LocalMachine | SYSTEM, Administrators; 3 tài khoản dịch vụ chỉ đọc |
| `…\logs` | log cài đặt + log dịch vụ (WinSW xoay vòng 10 MB × 8) | + 3 tài khoản dịch vụ (ghi) |
| `…\run` | nhịp tim worker | + worker (ghi) |
| `…\sender` | tệp của Sender | + sender (ghi) |
| `…\backup` | bản sao lưu (bước 4) | SYSTEM, Administrators |

## Secret (chỉ nêu tên và nơi lưu, không nêu giá trị)

Tất cả được sinh bằng CSPRNG lúc cài, nằm trong `secrets.dpapi`, và không có trong source hay bộ cài:
`PG_SUPERUSER_PASSWORD`, `CRM_DB_PASSWORD`, `SENDER_DB_PASSWORD`, `DATA_ENCRYPTION_KEY_BASE64` (mã hóa SĐT/tên/khóa ký),
`PHONE_HASH_PEPPER`, `CRM_SESSION_SECRET`, `SENDER_JWT_SECRET`, `SENDER_ENCRYPTION_KEY`, `GATEWAY_SENDER_ENC_KEY`,
`ZALO_SESSION_ENC_KEY` (mã hóa phiên Zalo), `SENDER_V2_CLIENT_ID` và `SENDER_V2_SIGNING_KEY` (CRM ↔ Sender).

`launch.ps1` giải mã secret vào biến môi trường của đúng tiến trình dịch vụ. Secret không được ghi ra file rõ và không ra log.
Giới hạn: DPAPI LocalMachine nghĩa là mọi tiến trình có quyền đọc file đều giải mã được, nên ACL mới là lớp bảo vệ chính.
Sao chép ổ đĩa sang máy khác thì không giải mã được. Vì vậy phiên Zalo và dữ liệu mã hóa cần khóa khôi phục (bước 4).

## Nợ kỹ thuật đã biết

- Thư viện production của Sender (aws-sdk, firebase-admin, exceljs…) vẫn nằm trong gói vì code ZaloCRM import chúng. Bản giải nén 823 MB, bộ cài ~165 MB.
- WinSW dừng dịch vụ bằng cách kết thúc cây tiến trình, nên node không có graceful shutdown. Hàng đợi vẫn an toàn nhờ
  sổ `DeliveryAttempt` (IN_FLIGHT → UNKNOWN, không tự gửi lại), nhưng nên chuyển sang launcher gửi Ctrl+C.
- Bộ cài và gói cập nhật chưa ký số Authenticode (theo quyết định của anh Huy). Gói cập nhật được bảo vệ bằng manifest ký Ed25519 + SHA-256.
- Khay hệ thống mới là bản thử viết bằng PowerShell/WinForms.
