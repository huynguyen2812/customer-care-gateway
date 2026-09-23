# Security boundaries

- No cross-database connections.
- No tenant selection from request parameters.
- Secrets are reveal-once; only SHA-256-derived signing keys are stored for request verification.
- Phone and recipient names are encrypted with AES-256-GCM. Logs and audit metadata must use masking.
- Nonces are unique per installation and stale timestamps are rejected.
- Zalo session material must be encrypted and never exported to a browser or logs.
- The mock adapter is the only enabled channel in Phase 2.
- Personal Zalo is an unofficial, no-SLA channel. A 200/day limit does not guarantee account safety.
- MVP forbids automated friend requests and bulk messaging to strangers.

## VETCLINIC CRM (customer-facing)

- Customers use only `/api/v1/crm/*`. `/api/v1/admin/*` is internal operations only and must be
  restricted to the operator network at the reverse proxy; CRM sessions are never accepted there.
- Tenant, user, roles and product come from the server-side `CrmSession` created after a verified
  Platform token-exchange (RS256/JWKS, single-use code, state cookie, jti replay guard). No tenantId,
  userId or product code is accepted from the browser.
- Session cookie is opaque (HttpOnly, Secure + `__Host-` in production, SameSite=Lax); CSRF token is
  HMAC-bound to the session and required with a same-origin Origin on every mutation.
- Every ID from the client is resolved inside the session tenant; foreign IDs return the same 404 as
  unknown IDs. Responses are redacted server-side (secrets hidden, phones masked).
- Platform events are HMAC-signed over the raw body, timestamp-bound (±5 min) and idempotent by eventId.
- Suspended/expired/revoked entitlements revoke sessions, block new care jobs, and make the worker
  hold (suspended) or cancel (expired/revoked) queued jobs. Tenants may pause their own auto-send;
  only operators control the global kill switch.

## Multi Zalo accounts

- Accounts, routing rules and delivery attempts carry `tenantId`; composite `(id, tenantId)` foreign
  keys make a cross-tenant rule or attempt impossible at the database level.
- Sender credentials are per account and encrypted; they are never returned by any CRM response,
  never logged, and never copied from other products.
- Duplicate-send protection: DB allows one SENT and one open attempt per job; attempts are committed
  IN_FLIGHT before the network call; UNKNOWN outcomes are never failed over and are retried only with
  the same `deliveryAttemptId` on a sender that declares `idempotentSend`, otherwise parked
  `DELIVERY_UNCERTAIN` for manual review. A certain NOT_SENT is the only failover trigger.
- Quota: atomic per-scope counters (tenant = min(tenant cap, plan `dailyQuotaMax`), installation,
  account), day boundary in the configured timezone. Without a Platform plan limit, a single account
  is capped at 200 messages/day in the CRM (conservative; not a Zalo safety guarantee).
- MOCK never acts as a silent fallback: only with `MOCK_ADAPTER_ENABLED=true`, non-production and an
  explicit MOCK account. ZNS is refused with `CHANNEL_NOT_SUPPORTED` until an adapter exists.
- QR login shows only a sender-generated PNG data URL; the CRM never fabricates a QR and never
  receives cookies/session material.

## Sender v2 — vòng 2

- Health callback: xác thực bằng khoá của chính account (account phải thuộc đúng sender client), raw body, ±5 phút,
  nonce một lần, eventId idempotent; tenant lấy từ DB, không từ request; audit không chứa cookie/phiên/khoá/số đầy đủ.
- Tự đăng ký: client/tenant phía sender suy ra từ chữ ký; `SENDER_V2_SIGNING_KEY` chỉ nằm trong env Gateway và bản mã
  hoá trong `ZaloAccount.credentialEnc`, không bao giờ trả qua API.
- Resume chỉ bỏ pause sau khi sender xác nhận; không có thời điểm Gateway báo hoạt động mà sender không có phiên.
