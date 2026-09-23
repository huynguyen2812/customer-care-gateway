# Multi-Zalo sender contract v2

Status (2026-09-24): implemented on both sides and tested end-to-end with a **fake Zalo provider**
(sender: ZaloCRM-upstream branch `feat/multi-zalo-sender-v2`, report `docs/qa/claude-multi-zalo-sender-v2-round-2-2026-09-23.md`).
**Not tested with a real Zalo account; not production-ready.** See §9 for round-2 additions.

This document is the handoff to whoever owns the sender. The Gateway never assumes a capability the
sender has not declared.

## 1. Principles

1. One Zalo account = one isolated session on the sender. The sender addresses it by the Gateway
   account id (`channelAccountId`, a UUID) and never mixes cookies/sessions between accounts or tenants.
2. The sender never returns cookies, session blobs, IMEI, user-agent secrets, access tokens or full
   phone numbers to the Gateway. Only a masked phone (`090****321`), display name and status.
3. The sender only messages an **existing friend or existing conversation** resolved from a known
   phone number. No friend requests, no stranger discovery, no bulk campaigns.
4. Every outcome must say whether the message **may have reached Zalo**. Ambiguity is always
   `UNKNOWN`, never `NOT_SENT`.

## 2. Registration and capabilities

Per account, Platform/operator control stores on the Gateway `ZaloAccount`:
`senderBaseUrl` (HTTPS, or loopback in development), `senderClientId`, encrypted HMAC signing key
(`credentialEnc`) and `capabilities`:

```json
{ "contractVersion": 2, "qrLogin": true, "recipientPreflight": true, "idempotentSend": true, "remoteControl": true }
```

Missing/false capability ⇒ the Gateway does not call that feature:
- no `qrLogin` ⇒ CRM "Đăng nhập Zalo" answers `501 SENDER_NOT_SUPPORTED` (no fake QR is shown);
- no `recipientPreflight` ⇒ no preflight; account chosen by routing only;
- no `idempotentSend` ⇒ an `UNKNOWN` outcome parks the job (`FAILED/DELIVERY_UNCERTAIN`), never resends;
- no `remoteControl` ⇒ pause/resume/disconnect only stop Gateway routing (`senderApplied=false`).
- `delivery` fields in responses are trusted only when `contractVersion >= 2`.

## 3. Request signing (all endpoints)

Headers: `x-gateway-client-id`, `x-gateway-timestamp` (Unix ms), `x-gateway-nonce` (UUID),
`x-gateway-account-id` (Gateway account UUID), `x-gateway-signature` =
hex HMAC-SHA256(signingKey, `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(rawBody)`), rawBody = canonical
JSON (empty string for GET).

Sender MUST: reject |now − timestamp| > 300 s; reject a reused nonce (per client, ≥ 10 min window);
reject when `x-gateway-account-id` differs from the account in the path/body; answer `401` before
touching Zalo. If its replay store is down it answers `503 REPLAY_STORE_UNAVAILABLE` before any send.

## 4. Endpoints

| Method & path | Purpose |
|---|---|
| `POST /internal/v1/accounts/:id/login/start` | Start QR login. `200 {loginId, qrImage:"data:image/png;base64,…", expiresAt}` |
| `GET /internal/v1/accounts/:id/login/:loginId` | `200 {status: PENDING\|SCANNED\|CONNECTED\|EXPIRED\|FAILED, displayName?, phoneMasked?}` |
| `POST /internal/v1/accounts/:id/pause` / `resume` | Stop/allow sending on the sender side. `200 {ok:true}` |
| `POST /internal/v1/accounts/:id/disconnect` | Terminate and wipe the Zalo session. `200 {ok:true}` |
| `POST /internal/v1/accounts/:id/recipient-eligibility` | Preflight, body `{phoneE164}` |
| `POST /internal/v1/messages/send-known-contact` | Send, body below |
| (sender → Gateway) health callback | see §8 |

QR: `expiresAt` ≤ 3 minutes; a new `login/start` invalidates the previous loginId. Reconnect uses the
same flow; on success the sender replaces the account session atomically.

### Preflight

Body `{phoneE164}`. Response `{result}` ∈ `ELIGIBLE_EXISTING_FRIEND`, `ELIGIBLE_EXISTING_CONVERSATION`,
`NOT_FOUND`, `ACCOUNT_UNAVAILABLE`, `UNKNOWN`. It MUST NOT send anything, create a conversation,
send a friend request or write contacts. `423` = account unavailable.

### Send

```json
{ "deliveryAttemptId": "uuid", "idempotencyKey": "uuid (= deliveryAttemptId)", "channelAccountId": "uuid",
  "phoneE164": "+849…", "externalReferenceId": "appointment:…", "content": "…" }
```

**Idempotency (required for `idempotentSend`)**: the sender persists `deliveryAttemptId →
{state, providerMessageId}` durably *before* calling Zalo (state `SENDING`) and after
(`SENT`). A repeated request with the same `deliveryAttemptId`:
- already `SENT` ⇒ return the same `providerMessageId`, do not send again;
- still `SENDING` (crash mid-call) ⇒ return `UNKNOWN` (do not send again) unless it can verify with Zalo;
- never started ⇒ send normally.
Retention ≥ 7 days.

Response (contract v2):
```json
{ "delivery": "SENT", "providerMessageId": "…" }
{ "delivery": "NOT_SENT", "code": "RELOGIN_REQUIRED" }
{ "delivery": "UNKNOWN", "code": "ZALO_TIMEOUT" }
```

## 5. Error taxonomy — NOT_SENT vs UNKNOWN

`NOT_SENT` only when the sender **proves** no request reached Zalo for this attempt:

| code | meaning | Gateway action |
|---|---|---|
| `ACCOUNT_UNAVAILABLE` | session not loaded | account → DISCONNECTED, failover |
| `RELOGIN_REQUIRED` | session expired, detected before send | account → RELOGIN_REQUIRED, failover |
| `ACCOUNT_RESTRICTED` | Zalo restriction known before send | account → RESTRICTED, failover |
| `RATE_LIMITED` | sender-side limiter refused before send | account → RATE_LIMITED, failover |
| `ACCOUNT_PAUSED` | paused on sender | account → PAUSED, failover |
| `RECIPIENT_NOT_FOUND` | not a friend / no conversation | job terminal `RECIPIENT_NOT_FOUND`, no failover |
| `INVALID_REQUEST` | validation failed | job `FAILED` |

Everything else — Zalo timeouts, connection lost after the request was written, 5xx after the Zalo
call, `2xx` without a message id, unmapped codes — is `UNKNOWN`. Gateway handling of `UNKNOWN`:
retry the **same** `deliveryAttemptId` on the **same** account (max 3 sends, 2 min apart) only with
`idempotentSend`; otherwise park the job `FAILED / DELIVERY_UNCERTAIN` (quota kept, audit
`DELIVERY_UNCERTAIN`, no webhook) for manual review. **Never failover after UNKNOWN.**

Legacy v1 sender (current) classification in the Gateway: 400/401, `404 RECIPIENT_NOT_FOUND`,
`503 REPLAY_STORE_UNAVAILABLE` and connection refused ⇒ NOT_SENT; timeout, 423, 429, 5xx and 2xx
without id ⇒ UNKNOWN.

## 6. Gateway guarantees (implemented)

- `DeliveryAttempt` row per attempt; DB-enforced: ≤ 1 `SENT` and ≤ 1 open (`RESERVED/IN_FLIGHT/UNKNOWN`)
  attempt per job; `(id, tenantId)` composite FKs keep attempt/account/installation in one tenant.
- Attempt is committed `IN_FLIGHT` before the network call; a worker crash leaves it IN_FLIGHT and it
  is then treated as UNKNOWN (never a blind resend). A `RESERVED` attempt (crash before send) is
  closed as not sent and its quota released.
- Quota is reserved atomically per tenant/plan, installation and account inside the attempt
  transaction and released only on a certain NOT_SENT.
- Sticky account per job; failover only after certain NOT_SENT with an account-level code.
- MOCK is used only when `MOCK_ADAPTER_ENABLED=true`, outside production, and the tenant has an
  explicit MOCK account; it is never a silent fallback. ZNS returns `CHANNEL_NOT_SUPPORTED`.

## 7. Isolation

Sender stores sessions per account id, encrypted at rest, one process-level lock per account.
A request whose account id is not registered for the calling client id ⇒ `404` (same as unknown).
Logs never contain cookies, message content or full phone numbers.

## 8. Health callback (sender → Gateway) — proposed, not implemented in Gateway

`POST {gateway}/api/v1/channel/accounts/:id/health`, signed with the same scheme in reverse,
body `{status: CONNECTED|RELOGIN_REQUIRED|RESTRICTED|RATE_LIMITED|DISCONNECTED, reason?, at}`.
Idempotent by `(accountId, at)`. Until implemented, account status changes only via send outcomes,
QR login status and CRM actions.

## 9. Cập nhật vòng 2 (2026-09-24)

- Đăng ký: `POST /internal/v1/accounts/:id/register` (ký như mọi endpoint) — sender gắn account vào client đã ký,
  idempotent, id của client khác/đã thu hồi → 404. Gateway gọi tự động khi tạo account.
- §8 health callback đã có ở cả hai phía: Gateway `POST /api/v1/channel/accounts/:id/health`; sender dispatcher bật bằng
  `GATEWAY_HEALTH_CALLBACK_ENABLED=true` + `healthCallbackUrl` của client. Trạng thái: CONNECTED, DISCONNECTED,
  RELOGIN_REQUIRED, RESTRICTED, PAUSED.
- `pause`/`resume` trả `{ok:true, paused}`; resume khi hết phiên → 409 `RELOGIN_REQUIRED` / `ACCOUNT_UNAVAILABLE`.
