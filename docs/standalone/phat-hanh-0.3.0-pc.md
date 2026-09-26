# Quy trình phát hành đồng bộ CRM PC `0.3.0-pc` với Platform

- **Trạng thái (cập nhật 2026-09-26 tối):**
  - Platform đã deploy production (commit Platform `9b08d06`) và giao cấu hình công khai. Khóa đã được đóng gói (mục 1a).
  - **Vẫn BLOCKED phát hành**, vì còn thiếu:
    1. doanh nghiệp thử + mã kích hoạt production (chưa được cấp; **không** dùng doanh nghiệp khách thật);
    2. kích hoạt thật với Platform production;
    3. **kết nối nguồn B2B ↔ CRM PC còn khác contract xác thực/revalidation** (Platform ghi nhận là blocker riêng);
    4. Codex review và commit;
    5. cài mới / nâng cấp trên máy thử.
  - Có khóa Platform **không** đủ điều kiện phát hành toàn bộ sản phẩm.
  - **Chưa** build chính thức, **chưa** upload, **chưa** đăng manifest, **chưa** bật tự cập nhật cho khách (`customerRolloutEnabled=false` phía Platform).
- **Mốc mã nguồn hiện tại:**
  - CRM `feat/standalone-pc-edition` @ `7b699ac` = `origin` (commit của Codex, không tạo lại).
  - Sender `feat/standalone-pc-edition` @ `0f091e11` = remote `vetclinic`.
  - Trên `7b699ac` (tree sạch): unit 53/53, Platform giả lập 27/27, bản PC 18/18, VPS 117/117, build backend + web PASS.
- **Thay đổi chuẩn bị phát hành (chưa commit, chờ Codex review):**
  - `packaging/windows/tools/release-preflight.cjs`
  - `packaging/windows/release.ps1` (gọi preflight cho bản chính thức; tham số mới `-ExpectPlatformUrl`)
  - `test/release-preflight.spec.ts`
  - tài liệu này
- **Không đổi:** Client ID/Secret API cục bộ, chính sách bắt buộc kích hoạt, contract lease/`offlineGraceHours`. Không dùng khóa QA. Không bỏ kiểm tra giấy phép. Không bật lại CRM/Sender VPS.

## 1. Cần nhận từ task Platform (B2B)

| Hạng mục | Yêu cầu | Ghi chú |
|---|---|---|
| URL API thiết bị production | HTTPS, dự kiến `https://admin.vetclinic.vn/api/crm-pc/v1` | Đang ghi cứng trong `packaging/windows/VetclinicCrm.psm1` (`$script:PlatformDeviceApiUrl`). Nếu Platform chốt URL khác thì sửa dòng này và commit. |
| `keyId` + khóa công khai Ed25519 (SPKI PEM) | Khóa ký cấu hình **production**, không phải khóa QA | Đặt vào `packaging/windows/platform-config-keys.json` dạng `{"<keyId>": "<PEM>"}` và **commit** (khóa công khai, không bí mật). Khóa bí mật chỉ nằm trong secret store của Platform. |
| API đã chạy trên production | Migration Platform đã lên production (gồm `20260926010000_crm_pc_signed_config_lease`), redeem/sync/unpair hoạt động | Platform tự kiểm tra và báo kết quả. |
| Doanh nghiệp thử + mã kích hoạt | Một tenant thử có gói CRM và nguồn còn hiệu lực, chi nhánh đã ánh xạ UUID | Dùng cho bước kích hoạt thật (mục 3). |
| E2E của Platform trên bản cuối | Chạy lại harness Platform với fingerprint CRM của commit phát hành | Kết quả 18/18 cũ **không** dùng thay. |

## 1a. Đã nhận và đối chiếu (2026-09-26)

| Hạng mục | Giá trị | Đối chiếu |
|---|---|---|
| Nguồn | `D:\DuAn\crm-standalone\platform-production-public-config.json`; bằng chứng `platform-production-deploy-20260926.md` | Chỉ đọc |
| Commit Platform đã deploy | `9b08d06e835892733a603ab0bb1904d811d34111` | Có trong repo Platform (chỉ đọc) |
| URL API | `https://admin.vetclinic.vn/api/crm-pc/v1` | Trùng URL đã ghi trong `VetclinicCrm.psm1`; preflight với `--expect-platform-url` PASS |
| keyId | `vetclinic-crm-pc-prod-20260926` | Không có dấu hiệu khóa QA |
| Khóa công khai | Ed25519, SPKI SHA-256 `3697bd7600cf35c0c93a16a354323017a98c9580020e531be12c47ea874d7810` | Tính lại độc lập: trùng ở cả tin nhắn, file cấu hình và fingerprint được giao |
| Đóng gói | `packaging/windows/platform-config-keys.json` (chép nguyên khóa từ file Platform, không tạo khóa mới) | Qua PowerShell 5.1 → biến môi trường → `loadConfigKeys()` của CRM ra đúng keyId/fingerprint. Test `release-preflight.spec.ts` ghim keyId + fingerprint |

Đối chiếu code Platform đã deploy (`crm-pc-device.service.ts` tại `9b08d06`) với contract phía CRM:
- **Lease:** `max(5 phút, offlineGraceHours)`, cửa sổ gia hạn `min(24 giờ, lease/3)`, denial có chữ ký.
- **Thu hồi:** `403 DEVICE_REVOKED`; `401 DEVICE_UNKNOWN` / `DEVICE_AUTH_INVALID` / `DEVICE_REPLAY` không làm PC tự coi là bị thu hồi.
- **Redeem:**
  - retry chỉ trước hạn gốc 10 phút, sau đó `403 ACTIVATION_CODE_EXPIRED`;
  - các từ chối cho lần gửi đầu (`INVALID`, `EXPIRED`, `WRONG_PRODUCT`, `PLAN_NOT_ACTIVE`, `409 ACTIVATION_CODE_USED`, kể cả khi doanh nghiệp đã có PC chính) đều xảy ra **trước khi** tạo thiết bị ⇒ khớp quy tắc "chắc chắn chưa đăng ký" của CRM.
- **Mã chi nhánh:** UUID Platform; PETCLINIC thiếu mapping ⇒ cấu hình SUSPENDED với scope rỗng ⇒ PC giữ tin.
- **Kết luận:** không thấy lệch contract phía thiết bị. Lệch phía **nguồn B2B** (xác thực/revalidation của Source Connector) là blocker riêng, chưa xử lý trong lượt này.

## 2. Kiểm tra trước khi build (tự động)

```
node packaging/windows/tools/release-preflight.cjs --crm . --sender ../vetclinic-zalo-sender --out ../build \
  --version 0.3.0-pc --signing-key ../release-keys/vetclinic-crm-update-private.pem \
  --base-url https://vetclinic.vn/tai-ve/crm-pc/v3 --expect-platform-url https://admin.vetclinic.vn/api/crm-pc/v1
```

`release.ps1` tự chạy bước này cho **mọi** bản chính thức. `-AllowDirty` chỉ dùng được với phiên bản có hậu tố `-dev`/`-qa`, kể cả khi mã nguồn sạch, nên không còn cách build "bản chính thức" mà bỏ qua preflight.

Preflight **từ chối build** khi:
- **Mã nguồn:** CRM hoặc Sender còn thay đổi chưa commit, HEAD detached, upstream không phải `<remote được phép>/<branch>` (CRM: `origin`, Sender: `vetclinic`), hoặc HEAD khác commit của branch đó **trên remote thật** (`git ls-remote`, không tin ref tracking cục bộ có thể đã cũ). Remote không truy cập được, không xác thực được, hoặc branch không có trên remote ⇒ FAIL. Preflight không prompt, không fetch/push/pull, không in URL remote.
- **Phiên bản:** không có dạng `x.y.z-pc`, hoặc thư mục phát hành của phiên bản đó đã có.
- **Khóa Platform:** thiếu hoặc sai `platform-config-keys.json` (không phải Ed25519, có khóa bí mật, hoặc `keyId` kiểu QA/test).
- **URL Platform:** không phải HTTPS `admin.vetclinic.vn/api/crm-pc/v1`, hoặc khác URL Platform giao.
- **Kênh cập nhật:** BaseUrl khác `https://vetclinic.vn/tai-ve/crm-pc/v3` (địa chỉ kênh 0.2.x bị từ chối), hoặc bộ cài mặc định không đọc `…/v3/manifest.json`.
- **Khóa ký cập nhật:** khóa bí mật không khớp `update-public-key.pem`.

Sau preflight, `release.ps1` còn kiểm stage đem đóng gói phải đúng phiên bản, không build từ mã nguồn chưa commit, và đúng commit CRM/Sender hiện tại (chặn cả `-SkipBuild` dùng lại stage cũ).

Preflight chỉ in thông tin công khai: commit, keyId, fingerprint khóa, URL Platform, kênh cập nhật.

**Lượt chạy mới nhất (2026-09-26, remote thật):** CRM `origin` và Sender `vetclinic` khớp commit trên remote. Khóa Platform production, URL và khóa ký cập nhật đạt. **FAIL chỉ vì còn thay đổi chưa commit** (chờ Codex).

## 3. Thứ tự phát hành đồng bộ (Codex điều phối, anh Huy duyệt từng bước production)

1. **Platform** giao mục 1 (**đã nhận**). **Claude** đối chiếu contract (**đã làm**, mục 1a).
2. **Codex** review; commit các thay đổi chuẩn bị; push. Chốt **một** cặp commit CRM/Sender và số phiên bản `0.3.0-pc` cho cả hai phía.
3. **Kích hoạt với Platform thật** trên máy thử (không phải máy anh Huy đang dùng), bản build từ commit đã chốt, **doanh nghiệp thử** do Platform cấp (không dùng khách thật).
   - **Mã kích hoạt:** hẹn trước với bên Platform. Bên Platform chỉ tạo mã **ngay trước** lượt thử, khi máy thử đã mở màn "Kết nối Platform". Mã sống 10 phút tính từ lúc tạo. **Không** kéo dài thời hạn hay nới chống replay để tiện kiểm thử. Mã hết hạn ⇒ xin mã mới (hoặc đi luồng phục hồi nếu lần trước có thể đã đăng ký).
   - Kiểm:
     - kích hoạt;
     - đồng bộ và gia hạn;
     - gói bị tạm dừng/hết hạn ⇒ tin bị giữ;
     - ngắt ghép;
     - mất phản hồi và nhập lại đúng mã (trong 10 phút);
     - phục hồi khi mã hết hạn.
   - Xong: quản trị Platform thu hồi thiết bị thử.
4. **Build chính thức:** `release.ps1 … -Version 0.3.0-pc -BaseUrl https://vetclinic.vn/tai-ve/crm-pc/v3 -ExpectPlatformUrl https://admin.vetclinic.vn/api/crm-pc/v1` (không `-AllowDirty`). Lưu `SHA256SUMS.txt` và fingerprint (`scripts/qa/crm-pc-fingerprint.cjs --verify-build`).
5. **Cài trên máy thử sạch:** cài mới ⇒ thiết lập ⇒ kích hoạt ⇒ sao lưu ⇒ khôi phục sang máy khác (phải kích hoạt lại) ⇒ gỡ (dữ liệu còn) ⇒ khởi động lại Windows. Kiểm `settings.json`/khay: kênh cập nhật là `…/crm-pc/v3/manifest.json`.
6. **Nâng cấp từ 0.2.1 trên máy thử bằng bộ cài `.exe`** (không dùng tự cập nhật): dữ liệu còn nguyên, khóa máy `DEVICE_KEY_ENC_KEY` được bổ sung, kích hoạt được, kênh cập nhật chuyển sang v3 (kể cả khi `settings.json` để trống hoặc còn địa chỉ cũ).
   - **Vì sao phải dùng `.exe`:** tự cập nhật từ 0.2.x chạy `update.ps1` của bản **cũ**, nên **không** tạo `DEVICE_KEY_ENC_KEY`.
     - Biến môi trường Platform **vẫn** được dựng, vì dịch vụ chạy `launch.ps1` và module của bản **mới** (`packaging/windows/launch.ps1:8-13`).
     - Hậu quả: thiếu khóa máy ⇒ kích hoạt báo `DEVICE_KEY_UNAVAILABLE` ⇒ không gửi tin.
   - **Chặn tự cập nhật sai đường:** bản 0.3 dùng kênh riêng `/tai-ve/crm-pc/v3/`, và manifest 0.3 có `product` mà updater 0.2.x từ chối (`MANIFEST_INVALID`). Đã test bằng đúng công cụ updater của 0.2.1 (`test/update-channel.spec.ts`), xem `huong-dan-dang-ban-cap-nhat.md` mục 0.
   - **Nâng cấp bằng `.exe`:** bộ cài gọi `update.ps1` của bản **mới** (`installer/vetclinic-crm.iss:139-143`), script này bổ sung và lưu `DEVICE_KEY_ENC_KEY` (`update.ps1:55-57`).
   - **Máy thật hiện có:** máy anh Huy (0.2.1) có `updateManifestUrl` rỗng, trạng thái cập nhật `NOT_CONFIGURED`, nên không tự cập nhật. Bản 0.2.2 (đọc kênh cũ) chưa từng đăng lên web.
7. **Upload** (production, anh Huy duyệt) theo `huong-dan-dang-ban-cap-nhat.md`, **chỉ vào `/tai-ve/crm-pc/v3/`**:
   - trước: `.exe`, `.zip`, `SHA256SUMS.txt`;
   - tải lại và kiểm SHA-256;
   - **sau cùng** mới đăng `manifest.json` + `.sig` **của kênh v3**;
   - kiểm tra URL public; kênh cũ `/tai-ve/crm-pc/manifest.json` **không đổi**;
   - quay lui = đăng lại manifest v3 của bản tốt trước.
8. **Cấp mã kích hoạt cho từng khách khi khách đã sẵn sàng nhập** (đã cài xong, đang mở màn "Kết nối Platform"). **Không** cấp trước khi upload hay phát hành, vì mã chỉ sống 10 phút.

## 4. Không làm
- Không build/đăng `0.3.0-pc` khi preflight FAIL.
- Không dùng khóa QA (`crash-qa`, `demo-key`, khóa trong test) cho bản phát hành.
- Không đăng manifest trước khi gói đã lên đủ và kiểm tra đạt.
- **Không ghi đè/đăng manifest 0.3+ vào địa chỉ kênh cũ** `https://vetclinic.vn/tai-ve/crm-pc/manifest.json`.
- Không coi cờ `customerRolloutEnabled` phía Platform là cơ chế chặn updater (updater không đọc cờ đó).
- Không cấp mã kích hoạt trước khi khách sẵn sàng; không kéo dài thời hạn mã để tiện kiểm thử.
- Không bật lại CRM/Sender VPS.
