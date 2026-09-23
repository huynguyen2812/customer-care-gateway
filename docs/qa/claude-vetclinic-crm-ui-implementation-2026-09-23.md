# Báo cáo triển khai giao diện VETCLINIC CRM — 2026-09-23

- Người thực hiện: Claude. Trạng thái: **Đã chạy kỹ thuật trên local, đang chờ Codex review**. Anh Huy chưa duyệt, chưa sẵn sàng production.
- Nhánh: `feat/vetclinic-crm-customer-ui`, tạo từ `feat/petclinic-zalo-gateway` @ `0714a79`. HEAD vẫn là `0714a79` vì **chưa commit**.
- Nguồn thiết kế: `D:\DuAn\CRM GIAO DIEN.make`, commit `1b05cd2501091fceb6bb8f5a133fe2420b036071`. File được giải nén và dựng lại từ git packs vào thư mục tạm ngoài repo. File `.make` gốc không bị sửa.
- Repo không có `AGENTS.md` riêng. Em áp dụng `D:\DuAn\b2b-sales-management\AGENTS.md`.
- Repo thuộc user `CodexSandboxOffline`. Mọi lệnh git dùng `-c safe.directory=...` theo từng lệnh, **không** sửa cấu hình git global.
- Không đụng tới 2 file `customer-care-gateway-0714a79.tar.gz` và `customer-care-gateway-d6c9d19.tar.gz`. Đã thêm `*.tar.gz` vào `.dockerignore`.

## 1. File đã thay đổi

| File | Thay đổi |
|---|---|
| `web/**` (mới) | Mã nguồn giao diện production: React 19.3, Vite 8.3, Tailwind 4.3, lucide-react 1.47, recharts 3.10, font Be Vietnam Pro tự host (@fontsource). Có `package-lock.json` riêng. |
| `public/app.js`, `public/index.html`, `public/styles.css` | Xóa khỏi git (`git rm --cached`, đã stage). `public/` giờ là output build và nằm trong `.gitignore`. |
| `Dockerfile` | Thêm stage `web` để build giao diện; runtime copy `public/` từ stage này. |
| `.dockerignore`, `.gitignore` | Bỏ qua `web/node_modules`, `public` (output build) và `*.tar.gz`. |
| `package.json` | Thêm script `build:web`, `web:install`, `dev:web`. Không đổi dependency backend. |
| `README.md` | Thêm mục "Web UI (VETCLINIC CRM)": cách chạy local và production. |
| `docs/qa/claude-vetclinic-crm-ui-implementation-2026-09-23.md` và `docs/qa/screenshots/vetclinic-crm-ui-2026-09-23/*.png` | Báo cáo này và ảnh bằng chứng (chỉ có dữ liệu giả lập). |

**Không sửa:** `src/**` (NestJS), `prisma/**` (schema, migrations), `test/**`, sender adapter, logic gửi tin, cơ chế session/CSRF, `.env`.

## 2. Kiến trúc frontend đã chọn và lý do

- `web/` là **nguồn giao diện production duy nhất**. `vite build` ghi thẳng vào `../public`, thư mục NestJS đã phục vụ qua `useStaticAssets`, nên **không cần sửa `main.ts`**.
- Giao diện cũ (`public/app.js` và các file đi kèm) đã bị xóa, không còn chạy song song với giao diện mới.
- Định tuyến bằng hash (`/#/hang-doi`), vì vậy không cần fallback SPA trên server. Link thiết lập một lần vẫn giữ định dạng cũ `/#setup=<token>`.
- Session dùng cookie HttpOnly như cũ. CSRF token chỉ giữ trong bộ nhớ và gửi qua header `x-csrf-token` cho mọi lệnh POST. Không lưu token vào localStorage hay sessionStorage. localStorage chỉ lưu trạng thái thu gọn sidebar.
- Component dùng chung nằm trong `web/src/components/ui.tsx`: Button, Input, Select, Textarea, Badge, KPI card, DataTable, Pagination, Tabs, Modal, Drawer, Alert, Toast, EmptyState, ErrorState, Skeleton, ConfirmDialog, Switch, Checkbox. Không thêm thư viện UI nặng.
- Mọi lời gọi API đi qua `web/src/lib/api.ts`. Các chức năng chưa có backend đi qua `pendingApi`: lớp này luôn báo lỗi `MissingEndpointError` và **không bao giờ trả dữ liệu giả**.
- Vì sao không bê nguyên mã Figma Make:
  - `Login` so mật khẩu cứng `admin/123456` ngay trên trình duyệt.
  - `MessageTemplates` dùng `dangerouslySetInnerHTML`, có nguy cơ XSS. Em đã thay bằng cách dựng React node.
  - Các class `font-500/600/700` không tạo ra CSS nào trong Tailwind 4 (xem mục 8).
  - Toàn bộ dữ liệu trong mã thiết kế là mảng giả. Em đã thay bằng API thật hoặc trạng thái rỗng.

## 3. Ánh xạ màn hình Figma Make → route/component production

| Thiết kế (`src/pages`) | Route | Component | Nguồn dữ liệu |
|---|---|---|---|
| Login.tsx | (chưa đăng nhập), `/#setup=…` | `pages/Login.tsx` (`Login`, `Setup`) | `auth/login`, `auth/me`, `auth/setup` |
| Dashboard.tsx | `#/tong-quan` | `pages/Dashboard.tsx` | `overview`, `jobs`, `installations` |
| Customers.tsx | `#/khach-hang` (ngay sau Tổng quan) | `pages/Customers.tsx` | **Chưa có API**: hiện trạng thái rỗng |
| DataSources.tsx (+ PetclinicSources.tsx, trang mồ côi trong thiết kế) | `#/nguon-du-lieu` | `pages/DataSources.tsx` | `installations`, `POST installations/:id/petclinic`, `POST …/petclinic/preview` |
| ZaloChannel.tsx | `#/kenh-zalo` | `pages/ZaloChannel.tsx` | `installations[].zaloAccount`. Kết nối QR: **chưa có API** |
| MessageTemplates.tsx | `#/mau-tin-nhan` | `pages/MessageTemplates.tsx` | `templates`, `POST installations/:id/templates` |
| SendQueue.tsx | `#/hang-doi` | `pages/SendQueue.tsx` | `jobs?take=250`, `POST jobs/:id/cancel` |
| OptoutList.tsx | `#/tu-choi-nhan-tin` | `pages/OptoutList.tsx` | Chỉ có tổng số (`overview.counts.optedOut`). Danh sách: **chưa có API** |
| SystemLogs.tsx | `#/nhat-ky` | `pages/AuditLogs.tsx` | `audit?take=250` |
| SafetySettings.tsx | `#/cai-dat` | `pages/Settings.tsx` | `installations` (chỉ đọc). Tạm dừng: **chưa có API** |
| AdminProfile.tsx | `#/ho-so` | `pages/AdminProfile.tsx` | `auth/me`, `auth/logout`. Đổi mật khẩu: **chưa có API** |
| components/Sidebar.tsx | (khung) | `components/Sidebar.tsx` | Thu gọn 240↔60px, luôn thu gọn ở tablet, ngăn kéo ở mobile |

## 4. API thật đã nối

`GET auth/setup-status`, `POST auth/setup`, `POST auth/login`, `GET auth/me`, `POST auth/logout`, `GET overview`, `GET installations`, `GET jobs?take=250`, `GET templates`, `GET audit?take=250`, `POST jobs/:id/cancel` (hủy từng tin và hủy hàng loạt), `POST installations/:id/templates` (tạo, sửa, bật/tắt mẫu), `POST installations/:id/petclinic` (lưu cấu hình), `POST installations/:id/petclinic/preview` (kiểm tra kết nối và xem trước ở chế độ dry-run, không gửi tin). Tất cả thuộc `/api/v1/admin`.

Có chủ ý **không** đưa lên CRM khách hàng:
- `POST admin/kill-switch` (dừng khẩn cấp toàn hệ thống).
- `POST admin/installations` (tạo installation; API này trả clientSecret và callbackSecret).
- `POST …/personal-zalo` (đòi nhập URL sender và signing key).

## 5. API còn thiếu (em không tự tạo API giả)

1. **Phiên đăng nhập theo tenant cho khách hàng.** Đây là thiếu sót quan trọng nhất, xem mục 9.
2. Danh sách khách hàng và nhóm khách hàng theo tenant.
3. Danh sách từ chối nhận tin (số đã che, nguồn, lý do, ngày) và gỡ khỏi danh sách có ghi audit.
4. Tạm dừng/bật lại tự động gửi theo tenant. Cột `Installation.paused` đã có nhưng chưa có endpoint nào cho admin UI.
5. Cập nhật hạn mức và giờ yên tĩnh trong phạm vi gói.
6. Kết nối Zalo bằng QR (tạo QR, theo dõi trạng thái), ngắt kết nối, tạm dừng từng tài khoản Zalo.
7. Đổi mật khẩu quản trị và danh sách phiên đăng nhập.
8. Trạng thái tiến trình gửi nền (worker) dạng "được phép gửi hay không". Hiện UI chỉ biết cờ `paused` và kill switch, nên nhãn là "Tự động gửi đang **bật**" chứ không khẳng định "đang hoạt động".
9. Nội dung tin đã cá nhân hóa, lịch sử thử lại, kết quả verify nguồn cho drawer, và nút "Thử gửi lại".
10. API thống kê theo khoảng thời gian. Biểu đồ hiện tính từ tối đa 250 tác vụ gần nhất và có ghi chú điều đó trên giao diện.

## 6. Kết quả kiểm thử

| Hạng mục | Kết quả | Ghi chú |
|---|---|---|
| Cài dependency theo lockfile (`npm install` → `web/package-lock.json`; Docker dùng `npm ci`) | PASS | |
| Build frontend (`tsc --noEmit` + `vite build`) | PASS | Cảnh báo chunk JS 730 kB (recharts), chưa tách code |
| Build backend (`nest build`) | PASS | |
| Unit test Gateway (`npm test`) | PASS | 7 suite / 14 test |
| Test tích hợp (`npm run test:integration`) trên Postgres local của Gateway (`127.0.0.1:5441`, DB `customer_care_gateway`) | PASS | 4 suite / 7 test. Test chỉ dọn dữ liệu do chính nó tạo |
| Build Docker image local `customer-care-gateway:ui-qa-local` | PASS | Image chứa `public/index.html` title "VETCLINIC CRM". Không push |
| E2E trình duyệt: thiết lập một lần (mật khẩu không khớp → báo lỗi; hợp lệ → tạo tài khoản) | PASS | DB QA riêng `ccg_ui_qa` |
| E2E: đăng nhập sai / đúng | PASS | Thông báo tiếng Việt |
| E2E: phiên hết hạn (đổi `ADMIN_SESSION_SECRET` rồi khởi động lại) | PASS | Quay về trang đăng nhập với thông báo "Phiên đăng nhập đã hết hạn" |
| E2E: đăng xuất, tải lại trang vẫn ở trạng thái đăng xuất | PASS | |
| E2E: tải Tổng quan, chuyển đủ 11 màn | PASS | |
| E2E: Nguồn dữ liệu (modal, validate, kiểm tra kết nối báo lỗi khi nguồn không truy cập được) | PASS | PETCLINIC giả lập không chạy, nên chỉ kiểm được nhánh lỗi. Nhánh preview thành công: NOT RUN |
| E2E: Kênh Zalo (validate số điện thoại, stepper, QR báo "chưa hỗ trợ") | PASS | |
| E2E: Mẫu tin (bật/tắt gọi API thật có CSRF, chặn biến chưa khai báo) | PASS | |
| E2E: Hàng đợi (lọc, tìm kiếm, phân trang, drawer, hủy có xác nhận → POST cancel 201) | PASS | |
| E2E: Nhật ký (drawer, ẩn `apiToken`, che số điện thoại trong metadata) | PASS | |
| E2E: Cài đặt (tạm dừng có hộp thoại xác nhận, báo lỗi rõ vì thiếu API) | PASS | |
| Responsive 1440 / 768 / 375 (không cuộn ngang; menu mobile; drawer toàn màn hình) | PASS | Kiểm tra tự động `scrollWidth` bằng headless Chrome |
| Console không có lỗi nghiêm trọng | PASS | Chỉ có 401 dự kiến khi gọi `auth/me` lúc chưa đăng nhập |
| Không có request lặp vô hạn | PASS | Mỗi resource gọi đúng 1 lần mỗi lần tải hoặc làm mới |
| So sánh trực quan với bản thiết kế (dựng lại thiết kế từ `.make`, chụp cùng kích thước) | PASS có khác biệt | Xem mục 8 |
| Test với PETCLINIC/Zalo thật | NOT RUN | Đúng phạm vi |
| Duyệt của anh Huy / production | NOT RUN | |

Môi trường E2E:
- Chạy build production bằng `node dist/main.js` ở cổng 4101, trên DB QA dùng một lần `ccg_ui_qa` (tạo trong container Postgres local của Gateway và chạy `prisma migrate deploy` với các migration có sẵn, không đổi schema).
- Bí mật QA sinh ngẫu nhiên và chỉ nằm trong thư mục tạm; `WORKER_ENABLED=false`, `MOCK_ADAPTER_ENABLED=true`.
- Dữ liệu là giả lập hoàn toàn: "Khách QA", số `+84900000001`, adapter MOCK.

## 7. Ảnh bằng chứng

Thư mục `docs/qa/screenshots/vetclinic-crm-ui-2026-09-23/`:
- Bản triển khai, 1440px: `impl-1440-00-dang-nhap` đến `impl-1440-10-ho-so`, cùng các ảnh modal/drawer: `01b-xac-nhan-tam-dung`, `03b-nguon-du-lieu-modal`, `04b-kenh-zalo-modal`, `05b-mau-tin-editor`, `06b-hang-doi-drawer`.
- Tablet 768px: `impl-768-01-tong-quan`, `-03-nguon-du-lieu`, `-04-kenh-zalo`, `-06-hang-doi`.
- Mobile 375px: `impl-375-01-tong-quan`, `-03-nguon-du-lieu`, `-04-kenh-zalo`, `-06-hang-doi`, `-menu`.
- Bản thiết kế gốc để đối chiếu: `design-1440-00-dang-nhap` đến `design-1440-10-ho-so`.

## 8. Khác biệt còn lại so với thiết kế

1. **Độ đậm chữ.** Mã thiết kế dùng `font-500/600/700`, nhưng Tailwind 4 không tạo CSS cho các class này. Vì vậy bản xem trước Figma thực tế hiển thị gần như toàn bộ ở độ đậm 400. Em dùng `font-medium/semibold/bold` đúng ý đồ của class, nên tiêu đề và số KPI đậm hơn ảnh thiết kế. **Cần anh Huy/Codex chốt.** Nếu muốn giống hệt ảnh, chỉ cần đổi một chỗ.
2. Chỉ số KPI không có mũi tên tăng/giảm (+5, −3…) vì API không có dữ liệu kỳ trước để so sánh.
3. Bảng Hàng đợi dùng cột **Mã tham chiếu / Sự kiện / Nguồn dữ liệu / Mẫu tin** thay cho **Khách hàng / Thú cưng / Mã lịch / Chi nhánh**, vì API không trả tên khách, thú cưng hay chi nhánh (dữ liệu được mã hóa). Bộ lọc được mở rộng thêm nguồn, mẫu tin và khoảng ngày theo yêu cầu. Cột thao tác chỉ còn "Chi tiết"; hủy nằm trong drawer và hủy hàng loạt.
4. Checkbox dùng input gốc với màu thương hiệu, thay cho icon Square/CheckSquare.
5. Khách hàng và Từ chối nhận tin hiển thị trạng thái "Chưa có dữ liệu" thay cho bảng mẫu.
6. Nguồn dữ liệu: form PETCLINIC có đủ trường mà backend yêu cầu (mã phòng khám, chi nhánh, số điện thoại thử nghiệm, bật kết nối). "Tên kết nối" không có vì API chưa có trường tên; tên hiển thị là `PETCLINIC · <8 ký tự đầu mã>`. B2B SALE chưa có form cấu hình vì chưa có backend.
7. Cài đặt: hạn mức và giờ yên tĩnh ở chế độ chỉ đọc.
8. Nhật ký lọc bỏ các sự kiện `SYSTEM_*` (kill switch) và các mục không gắn với kết nối dữ liệu, vì đây là thao tác của Platform Admin.
9. Trong môi trường của Claude, trình duyệt tích hợp đôi khi chụp chậm một khung hình. Ảnh bằng chứng cuối cùng được chụp lại bằng headless Chrome.

## 9. Rủi ro bảo mật / tenant isolation

- **P0 — Chưa được đưa cho khách hàng dùng.** Toàn bộ `/api/v1/admin/*` là quyền **vận hành toàn hệ thống**: `overview`, `installations`, `jobs`, `templates`, `audit` trả dữ liệu của **mọi tenant**, không lọc theo tenant. Tài khoản `AdminUser` cũng không gắn với tenant nào.
  - Giao diện đã ẩn kill switch, tạo installation và nhập signing key, nhưng **ẩn trên giao diện không phải là phân quyền**. Người đăng nhập bằng tài khoản này vẫn gọi được các API đó.
  - Trước khi mở `crm.vetclinic.vn` cho khách, cần: tài khoản CRM gắn tenant, được cấp từ Platform Admin/SSO; API `/crm/*` suy ra tenant từ session; RLS hoặc filter theo tenant trên server; test chống IDOR.
  - Hiện giao diện chỉ phù hợp cho **một người vận hành nội bộ** (anh Huy).
- Nhiều tenant sẽ bị trộn lẫn trên cùng màn hình khi DB có hơn một tenant (hệ quả của P0 ở trên).
- `failureReason`, `lastError` và metadata audit được che số điện thoại và ẩn các khóa nhạy cảm ngay trên giao diện. Đây chỉ là lớp phòng vệ thứ hai; server vẫn phải redact.
- Font tự host, không gọi Google Fonts. Không có script bên thứ ba.
- Chưa có CSP/security headers phía Nest (không đổi trong task này).

## 10. Xác nhận an toàn

- Worker vẫn tắt (`WORKER_ENABLED=false` trong mọi lần chạy). Không gửi tin Zalo thật, không gửi thử. Chỉ dùng adapter MOCK trên DB QA.
- Không thay credential thật. Không tạo dữ liệu khách hàng thật. Không đọc DB của PETCLINIC, B2B hay Platform Admin.
- **Không** tạo migration mới. Chỉ áp các migration có sẵn vào DB QA local `ccg_ui_qa`.
- **Không** migration production, **không** commit, **không** push, **không** deploy, **không** đổi DNS.
- Còn lại trên máy local, có thể dọn khi Codex không cần nữa:
  - DB `ccg_ui_qa` trong container `customer-care-gateway-postgres-1`.
  - Image Docker `customer-care-gateway:ui-qa-local`.
  - Thư mục tạm của phiên (bí mật QA, script chụp ảnh).
