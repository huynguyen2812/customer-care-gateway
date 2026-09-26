# Hướng dẫn đăng VETCLINIC CRM bản PC lên vetclinic.vn/tai-ve/crm-pc/

Chốt với anh Huy (2026-09-25): mọi file nằm ở **https://vetclinic.vn/tai-ve/crm-pc/**. Địa chỉ manifest
`https://vetclinic.vn/tai-ve/crm-pc/manifest.json` được ghi cố định trong bộ cài từ bản 0.2.2-pc.

> Upload lên server production **chỉ làm khi anh Huy duyệt rõ**. Người làm theo quy tắc dự án là Codex hoặc anh Huy.
> Claude chỉ chuẩn bị file.

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

Ví dụ nginx (Codex điều chỉnh theo cấu hình thật của vetclinic.vn):
```nginx
location /tai-ve/crm-pc/ {
    alias /var/www/vetclinic-downloads/crm-pc/;
    autoindex off;
    client_max_body_size 0;
    location ~ /manifest\.json(\.sig)?$ { add_header Cache-Control "no-cache"; }
    location ~ \.(zip|exe)$ { add_header Cache-Control "public, max-age=31536000, immutable"; }
}
```

## 2. Mỗi lần phát hành (bản mới / bản vá)

1. Trên máy build, chạy:
   `release.ps1 … -BaseUrl https://vetclinic.vn/tai-ve/crm-pc -Version <x.y.z-pc> -Notes "<ghi chú>"`
   (**không** dùng `-AllowLocalUrl`).
2. Lấy các file trong `D:\DuAn\crm-standalone\build\release\<x.y.z-pc>\`.
3. **Upload theo đúng thứ tự:**
   1. `vetclinic-crm-<x.y.z-pc>.zip`
   2. `VETCLINIC-CRM-Setup-<x.y.z-pc>.exe`
   3. `SHA256SUMS.txt` (đổi tên thành `SHA256SUMS-<x.y.z-pc>.txt` nếu muốn giữ các bản cũ)
   4. **Sau cùng:** `manifest.json` và `manifest.json.sig`, ghi đè bản cũ.

   Lý do: manifest chỉ xuất hiện sau khi gói đã lên đủ, nên máy khách không bao giờ thấy bản mới khi gói còn thiếu.
4. Kiểm tra từ máy bất kỳ:
   - `https://vetclinic.vn/tai-ve/crm-pc/manifest.json` hiện đúng phiên bản mới.
   - SHA-256 của file `.zip` tải về khớp `packageSha256` trong manifest.
   - Trên một máy đã cài, chạy "Kiểm tra cập nhật" ở khay (hoặc `check-update.ps1 -CheckOnly`) ⇒ phải báo có bản mới.
5. Máy khách tự cập nhật lúc 03:15 hoặc 15 phút sau khi mở máy. Quy trình đó tự sao lưu trước, và tự quay về bản cũ nếu bản mới hỏng.

**Lưu ý:**
- Giữ lại 1–2 gói `.zip` cũ cho tới khi chắc mọi máy đã cập nhật. Có thể xóa gói cũ hơn.
- Link cho khách tải bộ cài: `https://vetclinic.vn/tai-ve/crm-pc/VETCLINIC-CRM-Setup-<phiên bản mới nhất>.exe`
  (hoặc làm thêm một trang HTML đơn giản trỏ tới file mới nhất).

## 3. Rút lại một bản lỗi

- Đăng lại `manifest.json` + `.sig` của **bản tốt trước đó**. Máy nào chưa cập nhật sẽ không cập nhật lên bản lỗi nữa.
- Máy đã lên bản lỗi mà vẫn chạy được thì không tự quay về (updater chỉ lên bản số lớn hơn). Cách xử lý: phát hành ngay một **bản vá số lớn hơn**.
- Bản lỗi không khởi động được thì máy đó đã tự quay về bản cũ lúc cập nhật.

## 4. Khóa ký

- Khóa bí mật: `D:\DuAn\crm-standalone\release-keys\vetclinic-crm-update-private.pem`.
  **Chỉ nằm ở máy build.** Không upload lên web và không đưa vào repo. Cần sao lưu ra nơi an toàn.
- Khóa công khai tương ứng đã nằm trong mọi bộ cài (`scripts\update-public-key.pem`).
- Nếu khóa bí mật bị lộ: tạo khóa mới, phát hành bộ cài mới, và khách phải cài lại bằng tay. Các máy cũ không tin khóa mới.
