# Project Backlog

Only genuinely unimplemented work belongs here. Completed behavior is documented
in `README.md`, `STACK_OVERVIEW.md`, and `docs/`.

## Delivery Order

1. Finish high-availability safety and recovery qualification.
2. Qualify billing payments and enforcement on disposable pilot sites.
3. Finish remote WordPress billing enforcement.
4. Build the isolated mail platform last.

## 1. High Availability

The current two-host system already provides one-way Syncthing website/runtime
replication, 30-minute logical database recovery points, a warm HP runtime,
automatic emergency promotion through Cloudflare Tunnel, former-primary
fencing, controlled automatic failback, bounded panel operations, deep backup
verification, and panel review/acceptance of Cloudflare-qualified failover
hosts.

### Independent Fencing Witness

- Deploy a genuinely independent third-location witness. It must not run on
  OPI5, HP, the same LAN, or the same power/ISP failure domain.
- Give it only the authority required to prove or perform old-primary fencing.
- Return the already implemented signed, recovery-bound, expiring receipt.
- Test unavailable witness, invalid signature, replay, stale recovery point,
  primary still reachable, successful fence, and witness recovery.
- Keep the explicitly risk-accepted `unreachable` policy available as a
  documented home-hosting fallback, not as quorum-based HA.

### Role And Pairing Controls

- Add panel-driven pairing-token rotation/revocation with overlap and rollback.
- Add guarded role transitions only where the host scripts can enforce them.
  Every transition requires preview, readiness checks, typed confirmation,
  audit history, and rollback; a settings dropdown must never directly change
  the machine role.
- Further simplify standby navigation to read-only recovery, replication,
  health, settings, and account surfaces.

### Recovery Qualification

- Perform a full replacement-host restore drill from local plus encrypted
  off-site backups, including websites, databases, panel state, NPM state and
  certificates, operator login, DNS rollback, measured RPO, and measured RTO.
- Run a final unattended OPI5 outage -> HP promotion -> OPI5 rebuild/failback
  drill after the external witness is deployed. HP must continue serving until
  OPI5 is restored and publicly healthy.
- Define numeric RPO/RTO targets. Keep logical snapshots unless the measured
  database-loss window justifies GTID/binlog replication.

### HA Acceptance Criteria

- New websites appear as candidates and require provider qualification plus
  explicit panel acceptance before automatic public cutover.
- A standby cannot provision, delete, update, issue certificates, modify DNS,
  run maintenance, or execute equivalent hidden mutations.
- Only one writable primary exists after promotion or failback.
- Failed or interrupted DNS/tunnel cutover has an exact durable rollback.
- Restored websites, databases, NPM state, panel state, and scheduled work pass
  the documented public and internal checks.

## 2. Billing Payment Qualification

The separate billing service, editable inventory, provisioning registration,
signed entitlements, renewal pages, WooCommerce settings/webhooks, reminder
outbox, local nginx enforcement, and fail-open hosting reconciler are
implemented. Production enforcement remains disabled until the following work
passes.

- Configure one hidden virtual WooCommerce **Hosting renewal** product.
- Qualify checkout, processing/completed payment, duplicate webhook, replay,
  expired link, amount/currency mismatch, refund, chargeback, and WooCommerce
  outage behavior.
- Exercise one disposable local site through active, reminder, grace,
  suspended, successful payment, automatic restoration, manual exemption,
  billing outage, panel restart, and global disable-all.
- Verify that imported and existing sites remain unenforced unless both the
  global switch and exact pilot allowlist enable them.
- Review bounded audit records, Telegram/SMTP alerts, renewal-page presentation,
  and rollback evidence before enabling any production site individually.

### Billing Acceptance Criteria

- Missing, stale, malformed, or unavailable billing state fails open.
- Duplicate or replayed payment events cannot extend service twice.
- A verified payment restores an allowlisted site without manual nginx, NPM,
  database, or filesystem changes.
- Payment URLs expose no customer PII or reusable credential.
- Billing never receives Docker, shell, hosting-database, or nginx write access.

## 3. Remote WordPress Billing Plugin

Enrollment, one-time credential exchange, encrypted credential storage,
Ed25519 entitlement signing, public-key rotation, authenticated polling,
heartbeat storage, Site Health diagnostics, deterministic ZIP builds, and the
Billing enrollment workspace are implemented.

- Add fail-open frontend suspension for a fresh signed `suspended` entitlement
  while preserving administrator login, wp-admin, WP-Cron, Site Health, and
  billing refresh.
- Add **Check billing now** and automatically restore after the next verified
  paid entitlement.
- Purge known WordPress page caches and request narrowly scoped Cloudflare
  invalidation when entering or leaving suspension.
- Add canonical-domain change approval, staging-clone detection, revoke and
  re-enroll flows, and uninstall cleanup.
- Show bounded plugin/PHP/WordPress compatibility and last-applied state in the
  Billing UI without collecting site content, visitor data, or user lists.
- Publish signed packages with checksums and a controlled, opt-in update
  channel; test rollback on supported WordPress/PHP versions.
- Pilot one disposable externally hosted WordPress site through enrollment,
  cloning, stale state, suspension, payment, cache purge, restoration,
  credential revocation, and plugin rollback.
- Keep non-WordPress remote sites notification-only until separate
  least-privilege provider adapters exist.

## 4. Separate Mail Platform (Last)

Do not begin production mailbox migration until HA and billing pilots pass.

- Build a separate Stalwart stack for SMTP submission/receipt and IMAP/JMAP,
  Roundcube for webmail, and a narrow `mail-control` API. Keep mail data,
  databases, networks, credentials, jobs, backups, and restore lifecycle
  isolated from hosting.
- Confirm independent inbound TCP 25, submission 587, IMAPS 993, static WAN
  address, PTR/rDNS authority, abuse procedures, and Amazon SES production
  access in `us-east-1` before client onboarding.
- Add idempotent domain provisioning for Stalwart, Cloudflare MX/SPF/DKIM/DMARC,
  SES identity/Easy DKIM/custom MAIL FROM, health checks, and rollback.
- Add mailbox, alias, forwarding, quota, suspend/resume, password reset, and
  safe deletion operations without logging passwords.
- Implement password-free account manifests, IMAP pre-sync/final-delta
  migration, progress/retry state, account export, and whole-platform export.
- Add encrypted local/off-site backups and isolated restore drills covering
  metadata, message blobs, signing keys, Roundcube state, authentication, and
  send/receive verification.
- Integrate a dedicated **Mail** workspace into `hosting-ui` only through the
  authenticated `mail-control` API. Website provisioning and mail provisioning
  remain independent until the mail pilot completes.

## Cross-Cutting Rules

- Keep MySQL and Redis unexposed from the host.
- Preserve per-site ownership, authentication, CSRF, and capability checks.
- Make external mutations idempotent, previewable, auditable, and reversible.
- Use durable jobs for long operations and coherent cancellation checkpoints.
- Pin tested ARM64/AMD64 container versions with health checks and bounded
  resources.
- Never commit credentials, tokens, private keys, dumps, certificates,
  customer data, production-domain inventories, logs, or unredacted screenshots.
- Update tests, documentation, installer/upgrade behavior, production hosts,
  and both GitHub repositories with each completed feature.
