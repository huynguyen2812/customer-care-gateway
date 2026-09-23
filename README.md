# Customer Care Gateway

Independent, tenant-isolated delivery gateway for operating PETCLINIC and B2B SALE.

Phase 2 implements the platform installation boundary, signed machine-to-machine requests,
idempotent care jobs, approved message templates, consent/opt-out policy, quiet hours, quotas,
audit redaction, a mock channel and an internal-only personal-Zalo sender adapter. The adapter has
has completed one explicitly authorized, single-recipient personal-Zalo pilot. It is not production-approved.

## Safety boundaries

- Tenant identity comes from the authenticated installation credential, never the request body.
- The gateway has its own repository, PostgreSQL database, secrets and deployment.
- No direct database access to Platform Admin, B2B SALE or PETCLINIC.
- One installation maps to one source product and one tenant.
- Personal Zalo and ZNS are replaceable channel adapters.
- The ZaloCRM-derived sender node is not public-facing and may only message an existing friend or
  conversation resolved from a known phone number; it never discovers or auto-adds strangers.
- The operating PETCLINIC connector is read-only, keeps its token encrypted, validates the approved
  tenant/branches, requires explicit messaging consent and a hashed pilot phone allowlist, defaults
  every sync to dry-run, and rechecks the appointment immediately before delivery.

See `docs/api-contract.md`, `docs/security.md` and `docs/status.md`.

## Containers

`docker-compose.yml` is the local PostgreSQL-only stack. `docker-compose.prod.yml` builds the
Gateway image, keeps PostgreSQL on a private Docker network, binds the API only to VPS loopback for
a reverse proxy, applies reviewed Prisma migrations at startup and exposes `/api/v1/health` for
readiness checks. Production secrets belong only in an untracked `.env.production` file.
