# Project Backlog

This file is the detailed plan for work that is not implemented. Completed
features are documented in `README.md` and `docs/`; they are removed from this
backlog only when their acceptance criteria are satisfied.

## Delivery Order

1. Adopt the shared background system for remaining long operations.
2. Repeat production WordPress update/rollback drills before scheduling.
3. Separate billing and hosting-entitlement service.
4. Separate mail platform with panel API integration.
5. Warm-standby replication and controlled failover.

The durable job system now handles backups, restores, maintenance, controlled
WordPress updates, image optimization, website deletion, website
provisioning/import, portable website exports, and staged multi-site imports.
Remaining long operations
should adopt it instead of creating another status file, lock, or browser-bound
request.

## 1. Remaining Background-Job Adoption

### Objective

Finish adopting the implemented durable job service for future bulk operations.

Website deletion now uses the durable job system with conflict locks, live
ownership revalidation, bounded progress, notification delivery, and
cancellation only at coherent safety boundaries. Destructive deletion jobs are
not retryable because a partially completed external deletion cannot be replayed
without a new ownership preview.

Website provisioning and single-site browser imports now return a durable job,
retain failed upload staging for 24 hours, and expose generated WordPress/MySQL
credentials through an encrypted 24-hour vault that removes them on first read.
Passwords never enter job payloads, results, errors, notifications, or Git.

### Requirements

- Register billing/mail migration handlers as those features are implemented.
- Add explicit safe cancellation checkpoints to each handler. Never interrupt a
  database import, file swap, credential update, or configuration write midway.
- Make panel-triggered shell migration operations use the same managers and
  compatible job/result records while retaining standalone recovery scripts.
- Remove legacy per-manager status files only after every existing screen reads
  shared job state and an upgrade has migrated any useful history.

### Acceptance Criteria

- Every remaining long panel operation returns immediately with a job ID and is
  observable without keeping the original request open.
- New handlers use existing conflict classes and cannot mutate the same website,
  database, runtime configuration, or external integration concurrently.
- Provisioning credentials have an explicit short-lived one-time retrieval path
  and never enter job payloads, results, errors, notifications, or Git.

## 2. Notification Expansion

### Objective

The panel now sends filtered terminal background-job results through Telegram
and external SMTP. Credentials are encrypted, tests are operator-triggered,
delivery retries are durable and deduplicated, and channel results are attached
to the originating job. Extend that event-driven system to service risks without
operating a local mail server or using Telegram as backup storage.

### Implemented Health Events

- Lightweight scheduled checks now cover required Docker containers, MySQL,
  the NPM API, certificates attached to enabled proxy hosts, website/backup
  storage thresholds, OPcache capacity/restart state, and opt-in end-to-end HTTPS
  checks for selected public websites.
- The **Health** workspace shows active incidents, transition history, and
  Telegram/SMTP delivery state. Alerts occur only on open, changed, and resolved
  transitions; recovery alerts bypass successful-job filtering.

### Remaining Event

- Hosting/domain renewal reminders after the billing service exists.

### Explicit Non-Goals

- Do not send website archives to Telegram; bot file limits and restore
  semantics make it unsuitable as backup storage.
- Do not make panel notifications depend on the future local mail platform.
  Notifications must continue to support an independent external SMTP relay;
  mailbox hosting is a separate infrastructure product and failure domain.

## 3. WordPress Maintenance And Controlled Updates

### Implemented

The Maintenance workspace now queues a durable, read-only inventory across
selected WordPress websites. It records core, plugin, and theme versions,
cached update availability reported by WP-CLI, active/inactive state, bounded
per-site errors, and the latest snapshot without executing update commands.

Controlled manual updates now support explicit core/plugin/theme selections,
all currently available updates, and uploaded package-library ZIPs. Each
one-site durable job refreshes its preview, creates and verifies a complete
files/database backup, enables maintenance mode, records before/after versions,
checks WordPress/database/front-page/admin health, purges caches only on
success, and automatically restores the verified backup on failure.
Persistent per-site exclusions can block the entire site, WordPress core,
installed plugin/theme slugs, or uploaded package-library sources. They are
enforced during preview and execution and record an operator reason and last
editor metadata.

### Remaining

The first production plugin update and forced-rollback drill passed on
2026-07-27 and is recorded in `docs/WORDPRESS_UPDATES.md`. Updates remain
manual. Before adding unattended schedules:

- complete at least two more production maintenance-window drills on dedicated
  temporary sites;
- cover WordPress core, a theme, a repository plugin, and an uploaded package
  across the full drill set;
- verify complete backup restoration, local-origin health, public HTTPS, cache
  purge behavior, notification delivery, and removal of every temporary
  external and local resource after each drill;
- record elapsed backup/update/rollback time and resolve every warning or
  rollback failure before counting a drill.

## 4. Separate Billing And Entitlement Service

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

## 5. Separate Mail Platform

### Objective

Add production mailbox hosting as a separately owned module with dedicated
containers, storage, network, API, upgrades, migration, and backup lifecycle.
It may live in the same repository and deployment, but it must not be coupled
to the hosting database or implemented directly inside `hosting-ui`.

### Service Boundary

- Run a dedicated Stalwart mail server for SMTP receiving, authenticated
  submission, IMAP/JMAP mailboxes, domains, aliases, quotas, filtering, and
  account management.
- Run Roundcube as the initial webmail client with its own configuration
  database. Roundcube preferences are separate from mailbox contents.
- Add `mail-control`, an authenticated internal API responsible for domain and
  account provisioning, Cloudflare and Amazon SES reconciliation, migration,
  exports, backups, restores, progress, and audit records.
- Use a separate worker for long-running migration and backup jobs when the
  shared job service cannot safely execute them directly.
- Keep mail containers on a dedicated `mail-net`. Give only `hosting-ui` and
  `mail-control` access to a narrowly scoped internal API network.
- Do not give the mail control service arbitrary Docker, shell, filesystem, or
  hosting-database access.

Initial logical services are `mail-stalwart`, `mail-webmail`,
`mail-webmail-db`, `mail-control`, and, if required, `mail-worker`. Pin tested
multi-architecture image versions rather than using `latest`.

### Mail Flow And Public Ports

- Receive Internet SMTP directly on TCP 25 at Stalwart.
- Offer authenticated submission on TCP 587 with STARTTLS; optionally support
  TCP 465 after testing.
- Offer IMAPS on TCP 993. Do not expose plaintext IMAP/POP by default.
- Relay outbound mail from Stalwart through the region-specific Amazon SES SMTP
  endpoint in `us-east-1`.
- Publish webmail through the existing reverse proxy. Keep mail administration
  behind Cloudflare Access, a trusted network, or both.
- Do not route SMTP or IMAP through the HTTP reverse proxy.
- Confirm ISP reachability, host firewall rules, static WAN addressing, TLS,
  DNS resolution, and abuse controls before accepting production mail.

### Domain Provisioning

Treat mail-domain onboarding and mailbox creation as different operations.
Adding another mailbox must not recreate domain-wide DNS or SES resources.

For **Add mail domain**:

- Preview and idempotently reconcile the Stalwart domain, Cloudflare DNS, SES
  identity, DKIM, custom MAIL FROM, configuration set, and health checks.
- Create a DNS-only `mail` A/AAAA record and MX record.
- Merge SPF safely so a domain never receives multiple SPF records.
- Create SES Easy DKIM CNAME records and custom MAIL FROM MX/TXT records.
- Create a conservative DMARC record and support later policy tightening based
  on observed reports.
- Create appropriate `webmail`, `autoconfig`, and `autodiscover` records or
  endpoints without overwriting unrelated records.
- Mark every managed record/resource with exact ownership metadata where the
  provider supports it, show a dry-run diff, and require confirmation before
  changing existing external state.
- Test inbound SMTP, authenticated outbound delivery, IMAP TLS, SPF, DKIM,
  DMARC, reverse DNS expectations, and webmail before reporting success.

For **Add mailbox**:

- Create an account with quota, aliases, forwarding rules, status, and optional
  catch-all behavior.
- Generate a one-time password or accept an operator-provided password without
  writing it to jobs, logs, exports, or audit records.
- Return tested client settings and webmail URL.
- Support suspend, resume, password reset, quota change, aliases, forwarding,
  and safe deletion with explicit data-retention choices.

### Amazon SES Integration

- Use SES only as the outbound relay; Stalwart remains responsible for incoming
  mail and mailbox storage.
- Verify each sending domain in `us-east-1`, configure Easy DKIM and custom MAIL
  FROM, and ensure the SES account has production access before client rollout.
- Use a configuration set plus bounce, complaint, rejection, and delivery
  events for domain/account health and operator notifications.
- Store region-specific SES SMTP credentials as secrets. Never expose AWS root
  credentials or broad administrator credentials to runtime containers.
- Define a dedicated least-privilege AWS identity for control-plane operations;
  evaluate temporary credentials such as IAM Roles Anywhere before storing a
  long-lived AWS API key on the host.
- Rate-limit sending per account/domain and expose queue, rejection, bounce,
  complaint, and SES quota health in the panel.

### Migration, Import, And Export

- Inventory source domains, accounts, aliases, forwarders, catch-alls, quotas,
  status, and approximate mailbox sizes before migration.
- Accept a password-free JSON/CSV manifest. Never include source or destination
  mailbox passwords in a portable export.
- Support IMAP pre-sync, validation, MX cutover, and final delta sync so large
  mailboxes do not require one long outage.
- Use Stalwart/Vandelay-compatible account archives for portable export and
  restore where practical; handle contacts, calendars, and Sieve filters as
  separate capabilities rather than assuming IMAP includes them.
- Generate new passwords when the source provider cannot export reusable
  password hashes.
- Show durable per-domain and per-account progress, retries, skipped items,
  byte/message counts, and bounded errors through the shared job system.
- Preserve rollback instructions and the old provider configuration until the
  migration and delivery verification window has passed.

### Backup And Restore

- Back up Stalwart metadata, message/blob storage, configuration, signing keys,
  Roundcube configuration/database, and password-free recovery manifests.
- Take a consistent embedded-database snapshot using a controlled quiesce or a
  documented backend-specific backup mechanism; never copy a live data store
  and assume it is consistent without validation.
- Support manual and scheduled backups, configurable destination and retention,
  checksums, encryption, bounded local retention, and an encrypted off-host
  copy independent of the server and attached backup disk.
- Keep migration exports as an additional portability mechanism, not the only
  routine disaster-recovery backup.
- Restore into an isolated test deployment on a schedule and record mailbox,
  message-count, attachment, authentication, and send/receive verification.
- Allow account-level export/restore and whole-platform disaster recovery with
  documented RPO, RTO, key recovery, and DNS rollback procedures.

### Panel Integration

- Add a dedicated **Mail** workspace for domains, mailboxes, aliases,
  forwarding, quotas, migrations, backups, delivery health, DNS/SES status, and
  audit history.
- `hosting-ui` calls only the authenticated `mail-control` API; it does not call
  Stalwart, Cloudflare, or SES directly for mail operations.
- Initially keep website provisioning and mail provisioning independent. After
  the mail platform completes a production burn-in, add an optional
  **Configure email domain** step that invokes the same idempotent mail API.
- A mail failure must not roll back an otherwise successful website unless the
  operator explicitly selected an atomic combined workflow.

### Rollout

1. Measure account count, total mailbox storage, growth, aliases, and source
   migration capabilities; confirm public port 25/587/993 reachability.
2. Build the isolated containers, secrets, API contract, DNS preview, backup,
   and restore workflow without migrating client mail.
3. Provision a dedicated test domain and internal mailboxes.
4. Test delivery, spam handling, TLS, SES events, rate limits, migration,
   backup, full restore, DNS rollback, and host restart behavior.
5. Run a limited pilot for several weeks and monitor queues, bounces,
   complaints, disk growth, resource usage, and backup restoration.
6. Integrate the stable API into the hosting panel and optional website
   provisioning step.
7. Migrate client domains in small batches with pre-sync, cutover, validation,
   final sync, and documented rollback.

### Acceptance Criteria

- Compromise or failure of webmail cannot grant control over the hosting stack,
  Cloudflare account, AWS account, or Docker host.
- Domain and mailbox operations are idempotent, previewable, auditable, and
  recoverable after panel or worker restart.
- A test message passes inbound and outbound TLS, SPF, DKIM, and DMARC checks;
  SES bounces and complaints reach the panel and notification system.
- A representative source mailbox migrates without missing folders/messages,
  and a final delta sync completes after DNS cutover.
- A full mail platform and an individual account can be restored from encrypted
  backups into an isolated environment using documented procedures.
- No credentials, private keys, mailbox contents, customer addresses, or
  production domains appear in Git, screenshots, logs, job summaries, or
  portable manifests.

## 6. Warm Standby And Controlled Failover

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
