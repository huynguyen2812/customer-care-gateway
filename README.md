# Customer Care Gateway

Independent, tenant-isolated delivery gateway for operating PETCLINIC and B2B SALE.

The production root serves a Vietnamese administration console. It uses an HttpOnly signed session,
same-site cookies and CSRF protection; the Platform Control HMAC secret is never exposed to the
browser. Configure `ADMIN_USERNAME`, a scrypt `ADMIN_PASSWORD_HASH`, and a random
`ADMIN_SESSION_SECRET` before enabling the console.

## Web UI (VETCLINIC CRM)

The only production UI source is `web/` (React 19 + Vite 8 + Tailwind CSS 4, design reference:
`CRM GIAO DIEN.make` @ `1b05cd2`). `npm run build:web` emits static assets into `public/`, which
NestJS serves via `useStaticAssets`; `public/` is build output and is not committed. Routing is
hash-based (`/#/hang-doi`), so no SPA fallback is needed; SSO errors return as `/#loi=<CODE>`. The UI calls only the tenant-scoped `/api/v1/crm/*` API. Customers sign in through Platform
Admin SSO (`/api/v1/crm/auth/start`); tenant and permissions come from the server-side CRM session
(HttpOnly cookie + in-memory CSRF token, never localStorage). `/api/v1/admin/*` stays for internal
operations only. Platform contract: `docs/crm-platform-contract.md`.

Local: `npm run web:install`, `npm run build:web`, `npm run build`, `npm start`. For UI work with
hot reload run the API on port 4100 and `npm run dev:web` (Vite proxies `/api` to 127.0.0.1:4100).
The Docker image builds `web/` in its own stage and copies the result into `public/`.

Phase 2 implements the platform installation boundary, signed machine-to-machine requests,
idempotent care jobs, approved message templates, consent/opt-out policy, quiet hours, quotas,
audit redaction, a mock channel and an internal-only personal-Zalo sender adapter. The adapter has
has completed one explicitly authorized, single-recipient personal-Zalo pilot. It is not production-approved.

## Safety boundaries

- Tenant identity comes from the authenticated installation credential, never the request body.
- The gateway has its own repository, PostgreSQL database, secrets and deployment.
- No direct database access to Platform Admin, B2B SALE or PETCLINIC.
- One installation maps to one source product and one tenant.
- Personal Zalo and ZNS are replaceable channel adapters. A tenant may own several Zalo accounts,
  routed per branch/installation/default with a per-job attempt ledger (docs/multi-zalo-sender-contract.md);
  real multi-account sending waits for sender contract v2 and is not production-ready.
- The ZaloCRM-derived sender node is not public-facing and may only message an existing friend or
  conversation resolved from a known phone number; it never discovers or auto-adds strangers.
- The operating PETCLINIC connector is read-only, keeps its token encrypted, validates the approved
  tenant/branches, requires explicit messaging consent and a hashed pilot phone allowlist, defaults
  every sync to dry-run, and rechecks the appointment immediately before delivery.

See `docs/api-contract.md`, `docs/security.md`, `docs/status.md` and `docs/multi-zalo-sender-contract.md`.

## Containers

`docker-compose.yml` is the local PostgreSQL-only stack. `docker-compose.prod.yml` builds the
Gateway image, keeps PostgreSQL on a private Docker network, binds the API only to VPS loopback for
a reverse proxy, applies reviewed Prisma migrations at startup and exposes `/api/v1/health` for
readiness checks. Production secrets belong only in an untracked `.env.production` file.
