# AI-SYNC

2026-09-24 — Nhận contract nguồn công nợ B2B tự động từ Platform. CRM lưu platform API base URL,
tạo/suspend/reactivate installation B2B theo sự kiện ký HMAC, xếp nhắc nợ có idempotency và revalidate
fail-closed trước gửi. Xem `docs/crm-platform-contract.md`; không thay bridge PETCLINIC.

2026-09-25 — Tích hợp nguồn lịch hẹn PETCLINIC do Platform quản lý, song song với cầu B2B.
CRM nhận sự kiện `petclinic_source.*` có chữ ký, lưu credential mã hóa, đồng bộ theo
phạm vi chi nhánh và revalidate fail-closed ngay trước khi gửi. Migration PETCLINIC được
đánh số `0012_petclinic_source_provisioning` sau migration cầu B2B `0011_b2b_source_bridge`.
Xem `docs/qa/codex-petclinic-crm-source-bridge-2026-09-25.md`.
