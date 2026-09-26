# Hướng dẫn phục hồi kích hoạt VETCLINIC CRM trên PC

Dành cho: **chủ doanh nghiệp** (người dùng CRM trên PC) và **quản trị Platform VETCLINIC** (bộ phận vận hành).
Áp dụng khi màn **Kết nối Platform** báo "Kích hoạt chưa hoàn tất".

> Phục hồi kích hoạt **không xóa** khách hàng, nguồn dữ liệu, lịch sử gửi, mẫu tin, phiên Zalo hay khóa API (Client ID/Secret) trên máy.
> Trong lúc chưa kích hoạt xong, máy **không tạo lịch nhắc và không gửi tin**. Vẫn đăng nhập, xem lịch sử, cấu hình nguồn và sao lưu bình thường.

## 1. Máy báo "Kích hoạt chưa hoàn tất" — còn trong 10 phút

**Nguyên nhân thường gặp:** mạng chập chờn đúng lúc bấm "Kích hoạt", hoặc máy bị tắt/mất điện giữa lúc kích hoạt, nên máy không nhận được phản hồi từ Platform.
Nếu máy vừa bật lại, có thể phải đợi khoảng 2 phút rồi mới thử lại được.

**Khách tự làm:**
1. Kiểm tra Internet.
2. Nhập lại **đúng mã vừa dùng** rồi bấm **Thử lại**. Máy không lưu mã nên phải gõ lại.
3. Mã chỉ dùng được trong **10 phút kể từ lúc quản trị Platform tạo mã** (không tính từ lúc bấm).

Nhập một mã khác lúc này sẽ bị từ chối ("Nhập lại đúng mã đó"). Đây là để tránh đăng ký hai thiết bị cho cùng một PC.

## 2. Máy báo "mã cũ không dùng được nữa" — quá 10 phút hoặc thiết bị đã bị thu hồi

Nút "Thử lại" không còn. Làm theo 3 bước, **đúng thứ tự**:

| Bước | Ai làm | Việc |
|---|---|---|
| 1 | **Quản trị Platform** | Mở Platform Admin → doanh nghiệp → VETCLINIC CRM → thiết bị PC. Tìm thiết bị có mã trùng với mã PC hiển thị trong mục "Phục hồi kích hoạt" (dạng `0331…0024`). Bấm **Thu hồi**. **Không** thu hồi nhầm PC đang dùng. |
| 2 | **Chủ doanh nghiệp** trên PC | Bấm **Xóa trạng thái ghép nối trên máy này…**, gõ `NGAT GHEP NOI`, bấm **Xác nhận**. |
| 3 | Quản trị Platform → chủ doanh nghiệp | Quản trị tạo **mã mới** và gửi cho khách. Khách nhập mã mới trên PC. Máy sẽ dùng mã thiết bị mới. |

Sau bước 2, màn hình hiện **hai kết quả riêng**:
- **Trên máy này:** đã xóa trạng thái ghép nối.
- **Trên Platform:** đúng câu Platform trả lời:

| PC hiển thị | Ý nghĩa | Cần làm thêm |
|---|---|---|
| Platform đã xác nhận ngắt ghép thiết bị này | Platform đã nhả thiết bị | Không |
| Platform cho biết hồ sơ thiết bị cũ đã được thu hồi | Bước 1 đã làm đúng | Không |
| Platform không có hồ sơ của thiết bị này | Lần kích hoạt trước chưa tới Platform | Không |
| **CHƯA xác nhận được trên Platform** | Mất mạng hoặc Platform báo lỗi | Quản trị Platform kiểm tra và **thu hồi thiết bị cũ** nếu còn, trước khi tạo mã mới |

Xóa trạng thái trên máy **không** có nghĩa Platform đã thu hồi thiết bị. Nếu Platform còn giữ thiết bị cũ, Platform sẽ không cho tạo mã mới.

## 3. Lưu ý

- Chỉ **chủ doanh nghiệp** thấy nút kích hoạt, thử lại và phục hồi. Nhân viên chỉ xem được trạng thái; máy chủ cũng từ chối nếu nhân viên gọi thẳng API.
- Nếu đang có một lần kích hoạt/phục hồi khác chạy, máy báo "Đang có thao tác khác, vui lòng đợi". Đợi 1–2 phút rồi thử lại.
- Không xóa database, không sửa bảng dữ liệu bằng tay, không cài lại máy để "làm sạch" kích hoạt.
- Mất mạng hoặc hết thời gian chờ **không** tự làm máy mất kích hoạt. Máy chỉ ngừng gửi khi giấy phép đã ký hết hạn.
