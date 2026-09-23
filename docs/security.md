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
