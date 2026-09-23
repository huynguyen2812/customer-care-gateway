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

## Operating PETCLINIC connector

Platform control configures `POST /installations/:id/petclinic`. Credentials are encrypted at rest;
responses and audit metadata never contain the token or phone numbers. The connection is valid only
for an installation whose source is `PETCLINIC_OPERATING`.

`POST /installations/:id/petclinic/sync` is dry-run unless the signed request explicitly contains
`{"commit":true}`. Eligible appointments must be scheduled/confirmed, belong to an approved branch,
carry explicit messaging consent and match the hashed pilot allowlist. A committed sync creates an
idempotent reminder job. The worker reads the appointment source again before sending, so cancellation,
rescheduling, loss of consent or removal from the pilot allowlist prevents delivery.
