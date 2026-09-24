# Delivery status

- Source/schema review: PASS
- Phase 2 source implementation: PASS for mock and internal personal-Zalo adapter scope
- Operating PETCLINIC connector implementation: PASS (read-only API, encrypted credential,
  tenant/branch gate, consent, hashed pilot allowlist, dry-run default, idempotency and pre-send recheck)
- Admin console: PASS (responsive dashboard, HttpOnly signed session, CSRF protection, one-time
  setup, installation/channel/template/job/audit controls and emergency kill switch)
- Unit tests: PASS (14/14)
- Database migration: PASS (5 forward-only migrations applied)
- Integration tests: PASS (7/7 against local PostgreSQL, signed HTTP API, loopback callbacks and
  a simulated operating-PETCLINIC API covering dry-run/idempotency/reschedule/cancellation)
- ZaloCRM sender TypeScript build: PASS
- Gateway-to-sender signed loopback contract: PASS
- ZaloCRM upstream full test suite: FAIL (368 passed, 44 failed, 23 skipped; baseline suite requires separate repair/environment work)
- ZaloCRM runtime dependency audit: FAIL (39 findings: 15 moderate, 23 high, 1 critical)
- Browser E2E: PASS locally for login, dashboard rendering and live overview data; production
  setup/login remains NOT RUN until deployment and the operator chooses the initial password
- Personal Zalo login/session reconnect: PASS (local pilot account)
- Personal sender no-send safety probe: PASS (unknown recipient 404, replay 401, invalid signature 401)
- Personal Zalo single-message pilot: PASS (one explicitly authorized recipient, HTTP 200,
  provider message id returned, recipient confirmed correct content; no bulk send)
- Operating PETCLINIC live dry-run: BLOCKED (no separately approved API credential and
  tenant/branch mapping is configured in Gateway; credentials were not copied from another product)
- Controlled 20/day appointment pilot: NOT RUN
- Production approval/release: NOT RUN

Gateway dependency audit after the pinned `multer@2.3.0` override: PASS (0 known vulnerabilities
reported by npm). This does not cover the isolated ZaloCRM sender, whose audit fails as stated above.

No production-readiness claim is made.

## VETCLINIC CRM tenant boundary (2026-09-23, branch feat/vetclinic-crm-customer-ui, uncommitted)

- Tenant-scoped `/api/v1/crm/*`, Platform SSO consumer, signed Platform events, migration 0006: PASS
  on local QA database only (unit 18/18, integration 41/41 incl. 34 CRM tenant/IDOR/entitlement tests).
- Browser E2E against a QA-only fake Platform: PASS (39/39). E2E with the real Platform: BLOCKED at
  the time; superseded 2026-09-24 — see "Platform ↔ CRM real E2E" below (API-level, not browser).
- Production approval/release: NOT RUN.

## Platform ↔ CRM vòng 2 — outbox bền vững, khóa/hủy khi CRM sập, xóa bản xuất sau hủy (2026-09-24, chưa commit, chờ Codex review)

- CRM: cancel cũ hơn entitlement hiện tại chỉ gỡ khóa; sổ xóa sau hủy không PII. Unit 22/22, integration
  115/115 (DB QA `ccg_deletion_e2e`).
- Platform: outbox `CrmEventOutbox` + worker, `CANCEL_PENDING`, xóa bản xuất sau hủy xác nhận (2 migration
  forward-only). Chi tiết + kết quả E2E HTTP thật và browser E2E: repo Platform
  `docs/qa/claude-platform-crm-e2e-and-deletion-round2-2026-09-24.md`.
- Production: NOT RUN. Không production-approved.

## Platform ↔ CRM real E2E + tenant termination (2026-09-24, chưa commit, chờ Codex review)

- E2E thật Platform API (build) ↔ CRM gateway (build) qua HTTP thật, 2 DB QA riêng
  (`qa_crm_e2e_platform`, `ccg_platform_e2e`): PASS 76/76 + 1 NOT RUN (không có route purge cho người
  dùng tenant nên không có gì để gọi). Harness và chi tiết: repo Platform `scripts/qa/crm-platform-e2e.mjs`,
  `docs/qa/claude-platform-crm-e2e-and-deletion-2026-09-24.md`.
- Lỗi thật tìm ra nhờ E2E: CRM từ chối `redirectUri` = `callbackBaseUrl` mà Platform gửi ⇒ mọi đăng
  nhập thật thất bại `REDIRECT_MISMATCH`. Đã sửa + 2 test hồi quy.
- Vòng đời xóa tenant (migration 0010 forward-only, `TenantLifecycleService`): unit 22/22, integration
  113/113 (gồm 9 test xóa tenant, 2 test redirectUri) trên DB QA `ccg_deletion_e2e`.
- Production: NOT RUN. Không production-approved.

## Multi Zalo accounts (2026-09-23, same branch, uncommitted, awaiting Codex review)

- Schema + forward-only migration 0007 with legacy backfill: PASS on QA DBs only (`ccg_multi_qa2`
  with synthetic legacy rows; `ccg_multi_e2e4` fresh); second `migrate deploy` = no pending.
- Routing, sticky selection, attempt ledger, atomic 3-tier quota, NOT_SENT/UNKNOWN handling, crash
  recovery, CRM account/rule APIs: PASS (unit 22/22, integration 77/77 incl. 36 multi-Zalo tests
  with a fake v2 sender, tenant A 3 accounts / tenant B 2 accounts).
- CRM UI (Kênh Zalo multi-account, phân công, Cài đặt, Hàng đợi attempts, sidebar summary): PASS
  browser E2E 42/42 at 1440/768/375 against QA-only fake Platform.
- Real sender support for QR login, recipient preflight, idempotent send, remote control and per-account
  sessions: BLOCKED (sender still v1, one fixed account). Therefore real multi-account sending and
  failover on a real sender: BLOCKED. Multi-account is NOT production-ready.
- Production migration/deploy, real Zalo accounts, real QR, real sends: NOT RUN (not authorized).

## Sender v2 — vòng 2 (2026-09-24, chưa commit, chờ Codex review)

- Health callback Gateway, tự đăng ký account, resume nhất quán: PASS (integration 95/95 gồm 18 test mới; unit 22/22).
- Tích hợp Gateway ↔ sender v2 qua HTTP thật, 2 tenant × 2 account, Zalo giả: PASS 17/17.
- Migration 0008 forward-only trên DB QA; deploy lần 2 không pending: PASS.
- Zalo thật: NOT RUN. Production: NOT RUN. Không production-ready.
- Vòng sửa cuối (2026-09-24): health callback quyết định APPLIED/STALE bằng UPDATE có điều kiện trên
  `ZaloAccount.lastSenderEventAt` (migration 0009) + INSERT ON CONFLICT cho eventId → an toàn khi đồng thời / commit đảo thứ tự.
  Gateway integration 102/102, unit 22/22; tích hợp chéo 18/18. Zalo thật: NOT RUN. Không production-ready.
