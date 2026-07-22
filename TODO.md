# Project Backlog

This file is the detailed plan for work that is not implemented. Completed
features are documented in `README.md` and `docs/`; they are removed from this
backlog only when their acceptance criteria are satisfied.

## Delivery Order

1. Shared background jobs and notifications.
2. Import/export controls in the authenticated panel.
3. Controlled WordPress updates and remaining maintenance options.
4. Cloudflare bulk presets and provisioning defaults.
5. Application adapters for generic PHP/MySQL and OpenCart.
6. Separate billing and hosting-entitlement service.
7. Encrypted off-site backups.
8. Warm-standby replication and controlled failover.

The job system is first because imports, exports, updates, off-site copies, and
bulk Cloudflare operations all need the same durable progress, conflict, audit,
and notification behavior.

## 1. Shared Background Jobs

### Objective

Replace separate task-status implementations with one durable job service used
by backups, restores, imports, exports, image optimization, maintenance,
WordPress updates, and future bulk operations.

### Requirements

- Persist a job ID, type, target sites, operator, status, timestamps, progress,
  current step, per-site results, warnings, and a bounded error/log summary.
- Support `queued`, `running`, `succeeded`, `failed`, `partially_succeeded`,
  `cancelling`, and `cancelled` states.
- Retain useful history across panel/container restarts with configurable
  retention and safe pruning.
- Define conflict classes so disk/database-heavy operations cannot overlap
  unsafely. Show why a job is queued and which job holds the conflicting lock.
- Allow cancellation only at explicit safe boundaries. Never interrupt a
  database import, file swap, credential update, or configuration write midway.
- Prevent duplicate submissions and make retries create a new job linked to the
  failed attempt.
- Add a **Jobs** panel workspace with active work, queue, history, filters,
  progress, result details, retry, and safe cancellation.
- Keep existing shell scripts usable for recovery and automation. They should
  call the same managers and produce compatible job/result records where
  practical.

### Acceptance Criteria

- A panel restart does not lose completed history or misreport an interrupted
  job as still running.
- Conflicting jobs queue or fail clearly; they never mutate the same website or
  database concurrently.
- Long operations return immediately with a job ID and remain observable
  without keeping the original browser request open.
- Job records never contain passwords, API tokens, SQL content, or private keys.

## 2. Telegram And SMTP Notifications

### Objective

Notify the operator about actionable failures and service risks without
operating a local mail server or using Telegram as backup storage.

### Initial Events

- Backup, restore, provisioning, import/export, image, maintenance, and
  WordPress-update failures.
- Certificate issuance/renewal failure and certificates approaching expiry.
- Low backup or website disk space.
- MySQL unavailable, public proxy unavailable, unhealthy hosting container, and
  OPcache full/restart-pending.
- Hosting/domain renewal reminders after the billing service exists.

### Delivery Requirements

- Support Telegram Bot API messages and email through an external SMTP relay.
- Store bot tokens and SMTP credentials with the panel's encrypted integration
  settings; never write them to logs or job results.
- Provide channel enable/disable controls, recipient/chat allowlists, a test
  action, severity filters, quiet hours, retry with backoff, and deduplication.
- Include installation, server, event, affected site, timestamp, short error,
  and a link to the relevant panel result. Do not include secrets or raw dumps.
- Record notification delivery status in the originating job/event.
- Keep health sampling lightweight and event-driven where possible; do not add
  a continuous high-cardinality metrics database.

### Telegram Commands: Later Phase

After notifications are stable, add only allowlisted commands such as
`/status`, `/site example.com`, `/purge example.com`, and
`/backup example.com`.

- Restrict commands by Telegram user and chat ID.
- Require confirmation for mutations, rate-limit requests, and write an audit
  record.
- Map commands to existing allowlisted panel operations. Never expose arbitrary
  shell, Docker, SQL, WP-CLI, or filesystem execution.

### Explicit Non-Goals

- Do not send website archives to Telegram; bot file limits and restore
  semantics make it unsuitable as backup storage.
- Do not add a local mail server. Deliverability, reverse DNS, SPF, DKIM,
  reputation, and abuse handling are a separate infrastructure product.

## 3. Import And Export In The Panel

### Objective

Expose the existing portable migration manager in the authenticated UI without
duplicating the tested shell-script logic.

### Export Workflow

- Select one, several, or all primary websites; aliases remain part of their
  primary site.
- Preview site type, document root, database, expected components, and export
  destination before starting.
- Run as a background job with per-site archive/dump progress and independent
  results.
- Show the generated export directory, checksums, manifest, size, and download
  controls for the manifest and reasonably sized artifacts.
- Preserve password-free manifests and generated target credentials.

### Import Workflow

- Accept a portable export manifest or lightweight `import-sites.json`.
- Support server-side staged directories as well as resumable browser uploads.
- Preview source paths, selected newest database dump, detected site type,
  aliases, DNS changes, NPM host/certificate actions, and conflicts.
- Reuse `MigrationManager`, archive validation, rollback, generated database
  credentials, runtime configuration, Cloudflare, and NPM integration.
- Retain failed staging for a bounded retry window and provide explicit cleanup.

### Acceptance Criteria

- Shell and UI imports produce equivalent runtime state.
- Progress survives navigation and panel restart through the shared job system.
- Existing files, databases, NPM hosts, or DNS records are never overwritten
  without a visible conflict decision and typed confirmation.

## 4. WordPress Maintenance And Controlled Updates

### Remaining Cleanup Work

- Add configurable post-revision retention with a safe default and previewed
  deletion count.
- Keep light cleanup weekly rather than daily.
- Continue isolating failures per operation and per site.

### Update Workflow

- Inventory WordPress core, plugin, and theme versions across selected sites.
- Allow core, selected plugin, selected theme, or all-compatible updates.
- Before each site update, create and verify a complete website/database backup.
- Put only the selected site into maintenance mode, update sequentially, and
  capture exact before/after versions.
- Run front-page HTTP, WordPress bootstrap, database, and admin-route health
  checks after the update.
- Purge Redis and FastCGI only after a successful update.
- Automatically restore the pre-update backup when update or health validation
  fails, then report both the original failure and rollback result.
- Support uploaded package-library ZIPs as explicit update sources without
  silently replacing packages on unrelated sites.

### Safety And Rollout

- Updates remain manual initially. Do not add unattended schedules until backup
  verification, health checks, and rollback have passed repeated production
  drills.
- Never run bulk updates concurrently across websites on this shared runtime.
- Expose exclusions/pinning for sites or packages that must remain on a version.

## 5. Cloudflare Bulk And Provisioning Automation

### Bulk Presets

- Select websites/zones and one or more idempotent presets:
  - WordPress login protection;
  - XML-RPC blocking;
  - sensitive-file blocking;
  - conservative bot/security baseline;
  - cache baseline;
  - optional Always Online.
- Produce a dry-run diff before mutation: zone, existing managed rule, desired
  change, entitlement/plan limitations, and records/rules left untouched.
- Apply sequentially as a background job with per-zone results.
- Store enough previous managed state for an explicit rollback where the
  Cloudflare API supports it.
- Change only panel-owned rules or exact confirmed DNS records.

### Provisioning Defaults

- Add a provisioning checkbox and preset selector for automatic security
  hardening after DNS/NPM setup.
- Allow a global default while preserving a per-site opt-out.
- Treat external integration failure as a warning after local site creation;
  provide a clear retry action.

### Incident Actions

- Build conservative actions from the existing selected-site traffic view:
  temporary IP/network mitigation, cache purge, or managed challenge/block.
- Require a preview, explicit confirmation, expiry, operator allowlists, and an
  audit log.
- Restore the real visitor IP from trusted Cloudflare ranges before attributing
  traffic.
- Never create permanent automatic bans from one traffic sample.

### Always Online Warning

Always Online is opt-in. Explain that it serves archived static content, cannot
preserve carts/comments/dynamic behavior, and may involve Internet Archive
integration.

## 6. Application Adapter Model

### Objective

Replace the current combined HTML/PHP classification with capability-driven
adapters. Do not provision OpenCart through WordPress-specific code.

### Target Adapters

| Adapter | Database | OPcache | FastCGI | Redis |
|---|---|---:|---:|---:|
| `static` | none | no | unnecessary | no |
| `generic-php` | optional | yes | opt-in with declared exclusions | application-specific |
| `wordpress` | required | yes | yes | supported |
| `opencart` | required | yes | yes with commerce exclusions | adapter-specific |

Each adapter defines:

- archive/document-root detection and safe extraction;
- database creation/discovery, credentials, dump import/export, and URL change;
- runtime pool and nginx requirements;
- cache capabilities and cookie/path exclusions;
- health checks, backup/restore, removal, and migration behavior;
- update behavior, or an explicit unsupported state.

### Generic PHP/MySQL

- Provision PHP-only or PHP plus a generated database/user.
- Let the operator upload an archive and optional SQL dump.
- Store connection details only where the application's declared configuration
  mechanism supports a safe write; otherwise display them once for manual use.

### OpenCart

- Detect supported OpenCart configuration files and document root.
- Import/create its database, rewrite canonical HTTP/HTTPS URLs, and validate
  storefront/admin bootstrap.
- Define session/cart/checkout exclusions before allowing FastCGI caching.
- Add OpenCart-specific backup, restore, removal, and migration tests.

## 7. Separate Billing And Entitlement Service

### Boundary

Build `hosting-billing` as a separate container with its own database, API, and
authenticated UI. `hosting-ui` remains responsible for server/site operations.
The services communicate through a narrow authenticated internal API.

### Data Model

- Service ID and domain.
- Customer/contact details.
- Hosting location/provider: local stack, remote shared hosting, or
  notification-only.
- Hosting and domain paid-through dates.
- Renewal interval, price, currency, grace period, and enforcement mode.
- WooCommerce order/payment identifiers.
- State calculated from dates: active, reminder, grace, suspended, exempt.
- Manual override, notes, and audit history.

CSV import/export is required for migration and operator editing, but the
billing database becomes the source of truth. Google Sheets synchronization can
remain a later optional adapter.

### WooCommerce Integration

- Use one hidden virtual **Hosting renewal** product, not one variation per
  domain and duration.
- Create orders/payment links with custom metadata: service ID, domain, period,
  amount, currency, and resulting renewal date.
- Receive signed WooCommerce webhooks, verify HMAC signatures, process
  idempotently, and retain payment/audit references.
- Restore service immediately after a verified successful payment when policy
  permits.

### Enforcement

- For locally hosted sites, enforce reminder/grace/suspended state at
  `hosting-nginx` so WordPress, generic PHP, and static sites behave consistently.
- Preserve a signed payment URL, manual exemption, and immediate rollback of
  the suspension rule.
- Remote sites require provider adapters, a WordPress plugin, or
  notification-only mode. Local nginx cannot suspend externally hosted sites.
- Never delete website data because payment expired.

## 8. Encrypted Off-Site Backups

### Objective

Replicate completed backup sets to independent S3-compatible object storage
with client-side encryption and tested restoration.

### Requirements

- Configure endpoint, bucket, region, credentials, encryption key source,
  bandwidth limits, schedule, and retention without exposing secrets.
- Upload only complete backup directories; ignore `.partial-*` and active
  staging.
- Preserve manifests and checksums, verify remote object completeness, and
  record the remote copy in job history.
- Retry interrupted uploads safely and prune only after a verified newer copy
  exists according to policy.
- Support manual replication and scheduled replication as background jobs.
- Add periodic restore tests into isolated non-production paths and report
  measured recovery time.
- Notify through Telegram/SMTP about success summaries and failures, but keep
  the backup payload in object storage.

### Acceptance Criteria

- Loss of the primary host and its attached backup disk still leaves a
  documented, decryptable, verified recovery point.
- Credentials and encryption material are absent from Git, logs, manifests, and
  notification messages.

## 9. Warm Standby And Controlled Failover

The manual architecture and failover runbook are documented in
`docs/HIGH_AVAILABILITY.md`. Implementation remains future work.

### Roles And Pairing

- Add explicit `standalone`, `primary`, and `standby` installation roles.
- Pair servers through a narrow authenticated API using independently rotatable
  credentials or mutual TLS.
- Show replication health, last successful sync, MySQL lag, recovery point,
  peer identity, and role in the panel.
- A standby must suppress provisioning, scheduled maintenance, backups,
  certificate issuance, DNS writes, and all other mutating control-plane work.

### Replication

- Use unique MySQL server IDs, GTID replication, encrypted credentials,
  retention sized for outages, and monitored replica lag.
- Replicate website files and required non-database application data one way
  with snapshot/staging semantics.
- Do not replicate Redis or FastCGI cache as authoritative state.
- Keep source releases pinned to the same tested commit and verify compatible
  schema/config migrations before promotion.

### Health And Promotion

- Check the active host from an independent location, not only from its standby.
- Require fencing so the old primary cannot serve traffic, write databases, or
  update Cloudflare before promotion.
- Begin with operator-confirmed promotion using the documented runbook.
- After repeated drills, optional automatic promotion may update selected
  Cloudflare DNS records to the standby WAN IP with anti-flap timing, quorum or
  witness confirmation, allowlists, and an audit trail.
- For one router/WAN address, promotion changes the router/load-balancer target;
  two NPM containers cannot simultaneously own public ports 80/443.
- Failback rebuilds the old primary from the new primary. Never merge two
  independently writable histories.

### Acceptance Criteria

- Planned promotion and failback meet measured RPO/RTO targets without
  split-brain.
- WordPress writes, NPM state/certificates, panel integrations, files, and
  scheduled work are correct after promotion.
- DNS rollback and emergency manual recovery remain possible if automation
  fails.

## Cross-Cutting Rules

- Keep MySQL and Redis unexposed from the host.
- Preserve per-site ownership and capability checks.
- Make external operations idempotent, previewable, and auditable.
- Require backups before destructive data or application updates.
- Never log or commit credentials, tokens, private keys, dumps, certificates,
  customer data, or production website names.
- Keep changes modular and usable on ARM64 and AMD64.
- Update tests, README, API, architecture, operations, UI guide, screenshots,
  installer/upgrade behavior, and both GitHub repositories with each feature.
