# API contract v1

## Installation authentication

Clients derive `signingKey = SHA-256(clientSecret)` and send:

- `x-care-client-id`
- `x-care-timestamp` — Unix milliseconds, maximum clock skew 300 seconds
- `x-care-nonce` — unique random value
- `x-care-signature` — hex HMAC-SHA256 over `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(rawBody)` using `signingKey`

The raw secret is revealed once and is never sent in a request. Tenant, product and scopes are derived
from the authenticated installation. A body `tenantId`, if supplied, is comparison-only.

## Care job

`POST /api/v1/care-jobs` requires `care:job:create` and the minimum fields agreed in the Phase 1
report. The database unique constraint `(installationId, idempotencyKey)` is authoritative. Reusing
the key with different canonical content returns `409 IDEMPOTENCY_CONFLICT`.

Supported terminal states: `SENT`, `FAILED`, `CANCELLED`, `OPTED_OUT`, `ACCOUNT_RESTRICTED`, and
`RECIPIENT_NOT_FOUND`. Non-terminal states are `QUEUED` and `PROCESSING`.

## Personal Zalo sender

Platform control configures an approved template and an encrypted sender signing key. Gateway renders
only allow-listed template variables, then calls the private sender endpoint with HMAC-SHA256 over
`timestamp.nonce.canonicalJsonBody`. The sender accepts only its fixed organization and Zalo account,
and resolves only an existing friend or existing conversation by normalized phone number.

## PETCLINIC connector

The connector supports both `PETCLINIC_OPERATING` and `PETCLINIC_ESSENTIAL`. For Essential, Platform
provisions the source automatically through the signed events in `docs/crm-platform-contract.md`;
the one-time Bearer credential is encrypted at rest and is never returned or written to audit/event
metadata. The legacy operator route `POST /installations/:id/petclinic` remains available for an
explicitly managed connection.

`POST /installations/:id/petclinic/sync` is dry-run unless the signed request explicitly contains
`{"commit":true}`. Eligible appointments must be scheduled/confirmed, belong to an approved branch
and carry explicit messaging consent. A pilot allowlist is enforced only when one is configured. A
committed sync stores the appointment time and revision snapshot in an idempotent reminder job.
Appointment timestamps must be ISO-8601 instants with an explicit `Z` or `±HH:MM` offset. CRM rejects
offset-less local timestamps instead of guessing a timezone. For example, 18:00 in Vietnam must be
sent as `2026-09-25T18:00:00+07:00` or the equivalent UTC instant `2026-09-25T11:00:00Z`.
Immediately before delivery, the worker calls PETCLINIC's dedicated revalidation endpoint with
`expectedAppointmentTime` and `expectedRevision`; only `eligible=true` with `reasonCode=ELIGIBLE`
may send. Network errors, malformed responses, missing snapshots, cancellation, rescheduling or
consent changes fail closed. CRM authenticates with Bearer only and never sends a tenant header.
For PETCLINIC appointment reminders over Zalo, source consent status `DEFAULT_ALLOWED` is mapped to
the internal allowed state exactly like `GRANTED`. An explicit `REVOKED`, `WITHDRAWN` or `OPTED_OUT`
always wins. This default never applies to SMS, marketing or any purpose other than
`APPOINTMENT_REMINDER`.
The worker also requires the local installation/tenant entitlement gate and source connection to be
active before revalidation. Suspend/revoke stops sync; revoke clears the credential and cancels only
the queued/processing jobs belonging to that source installation.

## Multi Zalo accounts (CRM, tenant-scoped)

A tenant owns many `ZaloAccount`s (statuses `PENDING_LOGIN, CONNECTING, CONNECTED, RELOGIN_REQUIRED,
PAUSED, RATE_LIMITED, RESTRICTED, DISCONNECTED, ERROR, REVOKED`; `paused` is a separate manual flag).
All routes take the tenant from the CRM session; a foreign or unknown account id returns the same
`404 NOT_FOUND`. Responses never contain the sender URL, client id, signing key, Zalo session or the
full phone number (only `phoneMasked`). Every mutation is audited.

| Route | Permission | Notes |
|---|---|---|
| `GET /crm/zalo-accounts` | `crm.zalo.read` | `{accounts[], tenantDailyLimit, maxAccountDailyWithoutPlan}`; each account has `sentToday`, `queuedJobs`, `usable`, `unavailableReason`, `capabilities`, `assignments[]` |
| `GET /crm/zalo-accounts/:id` | `crm.zalo.read` | + `recentAttempts[]` |
| `POST /crm/zalo-accounts` | `crm.zalo.manage` + usable entitlement | `{displayName, channel?, dailyQuota?, priority?, isDefault?}` → `PENDING_LOGIN`; first account becomes the tenant default |
| `PATCH /crm/zalo-accounts/:id` | `crm.zalo.manage` | `{displayName?, dailyQuota?, priority?, isDefault?: true}`; sum of account quotas ≤ tenant/plan limit (`403 PLAN_LIMIT`) |
| `POST /crm/zalo-accounts/:id/pause` · `/resume` | `crm.zalo.manage` (resume needs usable entitlement) | `{paused, senderApplied}` |
| `POST /crm/zalo-accounts/:id/disconnect` | `crm.zalo.manage` | stops routing now; `senderSessionTerminated` only with sender `remoteControl` |
| `POST /crm/zalo-accounts/:id/login/start` | `crm.zalo.manage` + usable entitlement | `{loginId, qrImage, expiresAt}` or `501 SENDER_NOT_SUPPORTED` |
| `GET /crm/zalo-accounts/:id/login/status?loginId=` | `crm.zalo.manage` | `{status}`; `CONNECTED` marks the account connected |
| `GET /crm/zalo-routing-rules` | `crm.zalo.read` | tenant rules |
| `PUT /crm/zalo-routing-rules` | `crm.zalo.manage` | `{rules:[{zaloAccountId, installationId?, branchId?, eventType?, priority?, active?}]}` replaces all atomically (≤ 200, duplicates `409 DUPLICATE_RULE`) |

Job list/detail add `branchId`, `selectedZaloAccountId`, `selectedZaloAccountName`, `selectedChannel`;
job detail adds `deliveryAttempts[]` (`attemptNumber, accountName, status, outcomeCode, sendCount, …`).
`PATCH /crm/settings` accepts `tenantDailyQuota` (≤ plan `dailyQuotaMax`, `null` = plan limit only).

Care-job create accepts an optional `branchId` (`^[A-Za-z0-9._:-]{1,80}$`, not part of the idempotency
hash); the PETCLINIC connector passes the appointment branch.

Account selection (worker): usable accounts of the job tenant only; branch rule (tier 1) > installation
rule (tier 2) > tenant default (tier 3); event-specific rules first; then rule priority, account priority,
today's load, id. Sticky per job. No eligible account ⇒ job requeued `NO_ELIGIBLE_ACCOUNT` (never MOCK).
Sender-facing contract: `docs/multi-zalo-sender-contract.md`.

## Platform tenant termination lifecycle (2026-09-24)

`POST /api/v1/crm/platform/events` (same HMAC headers as every Platform event, see
`docs/crm-platform-contract.md` §3/§3b) also accepts `tenant.deletion_requested`,
`tenant.deletion_cancelled` and `tenant.purge_requested`, each with
`deletion: { requestId, requestedAt, scheduledPurgeAt, retentionDays }`. There is no separate delete
endpoint. Response `200` = `{ accepted, eventId, result, requestId, platformTenantId, productCode,
status, completedAt, errorCode, errorMessage }` (+ `export`, `exportChecksum` for a PENDING request).
Errors: `401` signature/stale, `409` `REQUEST_TENANT_MISMATCH | DELETION_NOT_REQUESTED |
DELETION_CANCELLED | DELETION_ALREADY_OPEN | PURGE_NOT_DUE`, `503 PURGE_FAILED` (rolled back; retry
with the same `eventId` runs again). While a deletion is open, existing CRM sessions are revoked (`401`), a new login returns
`/#loi=ENTITLEMENT_INACTIVE`, the entitlement gate answers `403 TENANT_DELETION_PENDING`, source
products cannot create care jobs, and the worker holds (does not cancel) queued jobs.

Redelivery: Platform's durable outbox retries the same `eventId` for days; the CRM answers a duplicate
with the current ledger status and never re-applies it. A `tenant.deletion_cancelled` whose `occurredAt` is
older than the tenant's `entitlementUpdatedAt` lifts the lock only (`APPLIED_LOCK_ONLY_STALE_ENTITLEMENT`).

Platform-side (for reference, not served by CRM): `GET /api/platform/tenants/:id/crm-sync` (sync state,
last delivery, last error — no payload), `POST /api/platform/tenants/:id/crm-sync/retry`,
`POST /api/platform/crm-event-outbox/run-due`; `GET /api/platform/tenants/:id/deletion-export` returns
`410` once a cancellation is confirmed.

SSO callback: the token-exchange `redirectUri` claim, when present, must equal the provisioned
`callbackBaseUrl` (`{CRM_PUBLIC_ORIGIN}/api/v1/crm`) or the full callback URL; anything else is
`REDIRECT_MISMATCH`.

## Sender v2 — vòng 2 (2026-09-24)

- `POST /crm/zalo-accounts/:id/sender/register` (`crm.zalo.manage` + entitlement): đăng ký (lại) account với sender v2,
  idempotent. Tạo account (`POST /crm/zalo-accounts`) đã tự gọi bước này khi `SENDER_V2_*` được cấu hình. Sender chưa sẵn
  sàng → account vẫn tạo, `lastError=SENDER_REGISTRATION_PENDING…`, không có cấu hình gửi, `login/start` → 503
  `SENDER_REGISTRATION_PENDING`. Account của tenant khác → 404 như id lạ.
- `POST /crm/zalo-accounts/:id/resume`: hỏi sender TRƯỚC; chỉ bỏ pause ở Gateway khi sender xác nhận. Sender 409
  `RELOGIN_REQUIRED` → Gateway giữ pause, status `RELOGIN_REQUIRED`, trả 409 `RELOGIN_REQUIRED`; 409 khác → 409
  `ACCOUNT_UNAVAILABLE`; timeout/phản hồi lạ → 503 `SENDER_UNAVAILABLE`. Pause: khoá ở Gateway trước rồi báo sender.
  Sender không có `remoteControl` (v1/legacy) → chỉ đổi cục bộ như trước.
- `POST /api/v1/channel/accounts/:id/health` (không qua CRM session): health callback của sender. Ký
  `HMAC-SHA256(signingKey của account, METHOD\nPATH\nTS\nNONCE\nSHA256(rawBody))`, header
  `x-sender-client-id|timestamp|nonce|event-id|account-id|signature`. Account phải được đăng ký bởi đúng client ký.
  ±5 phút, nonce một lần (`ControlNonce`, tiền tố `sender:`), `eventId` idempotent (`SenderHealthEvent`, INSERT ON CONFLICT), sự kiện cũ hơn
  `ZaloAccount.lastSenderEventAt` → `STALE` (UPDATE có điều kiện, nguyên tử khi đồng thời). `PAUSED` chỉ áp dụng khi account đang `CONNECTED`. Lỗi xác thực → cùng 401.
