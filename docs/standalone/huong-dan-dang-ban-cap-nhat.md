# Hướng dẫn đăng VETCLINIC CRM bản PC lên vetclinic.vn/tai-ve/crm-pc/

> Upload lên server production **chỉ làm khi anh Huy duyệt rõ**. Người làm theo quy tắc dự án là Codex hoặc anh Huy.
> Claude chỉ chuẩn bị file.

## 0. Hai kênh cập nhật — KHÔNG được lẫn (cập nhật 2026-09-26)

| Kênh | Địa chỉ manifest | Dùng cho | `product` trong manifest |
|---|---|---|---|
| **Cũ (0.2.x)** | `https://vetclinic.vn/tai-ve/crm-pc/manifest.json` | Chỉ để trống hoặc giữ nguyên. Bản 0.2.2-pc đọc địa chỉ này; 0.2.0/0.2.1 để trống (không tự cập nhật). | `VETCLINIC CRM PC` |
| **v3 (0.3.x trở đi)** | `https://vetclinic.vn/tai-ve/crm-pc/v3/manifest.json` | Mọi bản 0.3.x+ (mặc định trong bộ cài mới). Gói `.zip`, `.exe`, `SHA256SUMS` cũng đặt trong `/tai-ve/crm-pc/v3/`. | `VETCLINIC CRM PC v3`, `channel: "v3"` |

**Vì sao tách:** trình tự cập nhật của 0.2.x chạy `update.ps1` **cũ**, không tạo khóa máy `DEVICE_KEY_ENC_KEY`. Nếu 0.2.x tự lên 0.3 thì máy **không kích hoạt được**, mà 0.3 bắt buộc kích hoạt, nên sẽ không gửi được tin.

**Hàng rào đã có (và đã được test):**
- **Bản 0.2.x từ chối manifest v3:** công cụ cập nhật của 0.2.x chỉ chấp nhận `product = "VETCLINIC CRM PC"` (bước `verify` báo `MANIFEST_INVALID` nếu khác). Manifest 0.3 có product khác, nên **mọi máy 0.2.x từ chối**, kể cả khi lỡ đăng manifest 0.3 ở địa chỉ cũ. Test chạy đúng công cụ của bản 0.2.1 đang cài (bản sao y hệt): `test/update-channel.spec.ts`.
- **Bản 0.3 từ chối manifest cũ và manifest bản thử:** chỉ chấp nhận `product = "VETCLINIC CRM PC v3"` và `channel = "v3"`. Manifest cũ bị từ chối. Manifest bản thử (`channel: "v3-qa"`) cũng bị từ chối, trừ máy QA đặt `VC_UPDATE_ALLOW_QA=1`.
- **Bản 0.3 cài bằng `.exe` tự đọc kênh v3:** nếu `settings.json` để trống **hoặc** còn địa chỉ cũ thì bản 0.3 dùng kênh v3; địa chỉ khác do quản trị đặt thì giữ nguyên.
- **Preflight chặn phát hành sai kênh:** từ chối `-BaseUrl` khác `https://vetclinic.vn/tai-ve/crm-pc/v3`, và từ chối bộ cài mặc định đọc sai kênh.

**Không bao giờ** ghi đè hay đăng manifest 0.3+ vào `/tai-ve/crm-pc/manifest.json`. Máy 0.2.x lên 0.3 **chỉ bằng bộ cài `.exe`**.

## 1. Cấu hình web (làm một lần)

Thư mục chỉ chứa file tĩnh, không cần code hay database. Yêu cầu:

| Yêu cầu | Lý do |
|---|---|
| Chỉ HTTPS (chuyển hướng http → https) | Trình cập nhật từ chối mọi địa chỉ không phải HTTPS |
| Cho phép file tới ~500 MB (không giới hạn body/timeout quá ngắn) | Gói cập nhật ~300 MB, bộ cài ~165 MB |
| `manifest.json` và `manifest.json.sig`: `Cache-Control: no-cache` | Để máy khách thấy bản mới ngay, không bị cache/CDN giữ bản cũ |
| File `.zip` / `.exe`: cache lâu được (tên file có số phiên bản nên không đổi nội dung) | Giảm tải server |
| Không bật trang liệt kê thư mục (directory listing) | Gọn, tránh lộ file cũ |
| Không yêu cầu đăng nhập | Khách tải tự do (anh Huy đã chốt) |

Ví dụ nginx (Codex điều chỉnh theo cấu hình thật của vetclinic.vn; khối này phủ cả `/tai-ve/crm-pc/v3/`):
```nginx
location /tai-ve/crm-pc/ {
    alias /var/www/vetclinic-downloads/crm-pc/;
    autoindex off;
    client_max_body_size 0;
    location ~ /manifest\.json(\.sig)?$ { add_header Cache-Control "no-cache"; }
    location ~ \.(zip|exe)$ { add_header Cache-Control "public, max-age=31536000, immutable"; }
}
```

## 2. Mỗi lần phát hành (bản mới / bản vá) — kênh v3

1. Trên máy build, chạy:
   `release.ps1 … -BaseUrl https://vetclinic.vn/tai-ve/crm-pc/v3 -Version <x.y.z-pc> -ExpectPlatformUrl https://admin.vetclinic.vn/api/crm-pc/v1 -Notes "<ghi chú>"`
   - **Không** dùng `-AllowLocalUrl`, **không** dùng `-AllowDirty`.
   - Preflight tự chạy và từ chối nếu:
     - mã nguồn chưa commit, hoặc HEAD khác đúng branch **trên remote thật**;
     - sai khóa Platform;
     - sai kênh.
2. Lấy các file trong `D:\DuAn\crm-standalone\build\release\<x.y.z-pc>\`.
3. **Upload vào `/tai-ve/crm-pc/v3/` theo đúng thứ tự:**
   1. `vetclinic-crm-<x.y.z-pc>.zip`
   2. `VETCLINIC-CRM-Setup-<x.y.z-pc>.exe`
   3. `SHA256SUMS.txt` (đổi tên thành `SHA256SUMS-<x.y.z-pc>.txt` nếu muốn giữ các bản cũ)
   4. **Sau cùng:** `manifest.json` và `manifest.json.sig` của kênh v3, ghi đè bản v3 trước đó.

   Lý do: manifest chỉ xuất hiện sau khi gói đã lên đủ, nên máy khách không bao giờ thấy bản mới khi gói còn thiếu.
4. Kiểm tra từ máy bất kỳ:
   - `https://vetclinic.vn/tai-ve/crm-pc/v3/manifest.json` hiện đúng phiên bản mới, `product` = `VETCLINIC CRM PC v3`, `channel` = `v3`.
   - `https://vetclinic.vn/tai-ve/crm-pc/manifest.json` (kênh cũ) **không đổi**.
   - SHA-256 của file `.zip` tải về khớp `packageSha256` trong manifest.
   - Trên một máy **0.3** đã cài, chạy "Kiểm tra cập nhật" ở khay (hoặc `check-update.ps1 -CheckOnly`) ⇒ phải báo có bản mới.
5. Máy khách 0.3 tự cập nhật lúc 03:15 hoặc 15 phút sau khi mở máy. Quy trình đó tự sao lưu trước, và tự quay về bản cũ nếu bản mới hỏng.

**Lưu ý:**
- Giữ lại 1–2 gói `.zip` cũ cho tới khi chắc mọi máy đã cập nhật. Có thể xóa gói cũ hơn.
- Link cho khách tải bộ cài: `https://vetclinic.vn/tai-ve/crm-pc/v3/VETCLINIC-CRM-Setup-<phiên bản mới nhất>.exe`
  (hoặc làm thêm một trang HTML đơn giản trỏ tới file mới nhất).
- **Mã kích hoạt Platform** chỉ sống 10 phút. **Không** cấp trước khi đăng bản. Chỉ cấp khi khách đã cài xong và đang ngồi trước màn "Kết nối Platform", sẵn sàng nhập.

## 3. Rút lại một bản lỗi (rollback)

- Đăng lại `manifest.json` + `.sig` của **bản v3 tốt trước đó** vào `/tai-ve/crm-pc/v3/`. Máy nào chưa cập nhật sẽ không cập nhật lên bản lỗi nữa. **Không** đụng kênh cũ.
- Máy đã lên bản lỗi mà vẫn chạy được thì không tự quay về (updater chỉ lên bản số lớn hơn). Cách xử lý: phát hành ngay một **bản vá số lớn hơn** trên kênh v3.
- Bản lỗi không khởi động được thì máy đó đã tự quay về bản cũ lúc cập nhật.
- Máy 0.2.x không bao giờ nhận bản 0.3 qua tự cập nhật, nên rollback kênh v3 không ảnh hưởng máy 0.2.x.

## 4. Khóa ký

- Khóa bí mật: `D:\DuAn\crm-standalone\release-keys\vetclinic-crm-update-private.pem`.
  **Chỉ nằm ở máy build.** Không upload lên web và không đưa vào repo. Cần sao lưu ra nơi an toàn.
- Khóa công khai tương ứng đã nằm trong mọi bộ cài (`scripts\update-public-key.pem`). Hai kênh dùng **cùng** khóa. Việc tách kênh dựa vào `product`/`channel` trong manifest đã ký, không dựa vào khóa.
- Nếu khóa bí mật bị lộ: tạo khóa mới, phát hành bộ cài mới, và khách phải cài lại bằng tay. Các máy cũ không tin khóa mới.
