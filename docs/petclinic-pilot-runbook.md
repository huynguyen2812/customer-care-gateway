# Operating PETCLINIC pilot runbook

This runbook configures a read-only appointment source and performs a dry-run. It never sends a
message and never commits a care job.

## Required approval

Obtain a dedicated server-to-server credential for Customer Care Gateway. Do not reuse browser
tokens or copy credentials from Finance, PETCLINIC Essential, Cầu Bom, or another product.

Confirm these values through Platform Admin:

- Gateway tenant UUID mapped to exactly one operating PETCLINIC tenant.
- Source API tenant id.
- Approved source branch ids.
- Pilot recipient phone numbers with explicit messaging consent. Start only with numbers owned by
  the operator; the Gateway stores only their keyed hashes in the allowlist.

## Local dry-run

Set the variables documented in `.env.example`, including the local Gateway database encryption
keys and the `PETCLINIC_*` variables. Then run:

```powershell
npm run db:migrate:deploy
npm run pilot:petclinic:configure
```

The second command creates or updates the operating-PETCLINIC installation, stores the API token
encrypted, installs the approved reminder template, and reads the appointment API. Its JSON output
must include `dryRun: true` and `noMessageSent: true`.

Never paste environment values into tickets, chat, Git, screenshots, or command output.

## Review gate before commit

Review the dry-run counts and skip reasons. A first committed pilot is allowed only when all are true:

- The API tenant and approved branch mapping were independently checked.
- Every eligible appointment has explicit messaging consent.
- Every eligible phone belongs to the pilot allowlist.
- The Zalo account remains connected and the kill switch works.
- Daily quota is at most 20 and quiet hours are enabled.
- The exact template content was approved.

Commit is a separate signed Platform Control call to
`POST /api/v1/installations/:id/petclinic/sync` with `{ "commit": true }`. Do not add `commit` to the
configuration script. This separation prevents an operator from accidentally sending while merely
setting up or checking credentials.

## Stop and rollback

Enable the system kill switch to stop delivery immediately. Set the PETCLINIC connection inactive
to stop future synchronization. Queued jobs can then be cancelled through the existing installation
or job controls. Revoking an installation revokes its credentials and cancels its queued jobs.
