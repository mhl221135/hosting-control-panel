# Project Backlog

This file is the detailed plan for work that is not implemented. Completed
features are documented in `README.md` and `docs/`; they are removed from this
backlog only when their acceptance criteria are satisfied.

## Delivery Order

1. Qualify live billing payments, then carefully pilot local enforcement.
2. Pass mail-platform feasibility gates, then build an isolated pilot.
3. Prove current-stack disaster recovery before adding warm-standby failover.

## 1. Separate Billing And Entitlement Service

Phase 1 is implemented as the isolated `hosting-billing` service. Its
read-only renewal inventory, legacy/canonical CSV round trips, audit history,
independent authentication, signed internal API, health endpoint, migrations,
verified backups, restore tests, and responsive UI are documented in
`docs/BILLING.md`. Remaining payment qualification and enforcement work must
preserve that service boundary.

Phase 2 code also implements encrypted WooCommerce settings, opaque expiring
payment links, one-active-link protection, signed topic-restricted webhooks,
amount/currency validation, idempotent delivery processing, and manual-review
handling without enforcement. It still requires live qualification against the
dedicated hidden renewal product before client use.

Renewal reminders are implemented with a disabled-by-default daily scheduler,
due-state preview, manual run, durable idempotent outbox, failure retry, and a
narrow bearer-authenticated adapter to the existing Telegram/SMTP delivery
queue. Billing has no access to notification credentials or panel data.

The hosting panel now also has a disabled-by-default, observe-only entitlement
consumer. It verifies the HMAC and snapshot age, retains an atomic
last-known-good copy, compares billing services with local primary websites,
and exposes mismatches without changing nginx or website state. Enforcement
remains unimplemented until a dedicated test-service pilot proves fail-open
behavior and immediate rollback.

### Data Model

- Stable service ID with one primary domain and optional aliases. Domains are
  mutable attributes, not database keys.
- Customer/contact details.
- Hosting location/provider: local stack, remote shared hosting, or
  notification-only.
- Separate hosting and domain paid-through dates, renewal intervals, and
  prices. A domain renewal must not silently extend hosting, and a hosting
  renewal must not silently extend the domain.
- Currency, grace period, enforcement mode, creation date, free-trial origin,
  and an archived flag. Records should be archived instead of hard-deleted
  after they have payment or audit history.
- WooCommerce order/payment identifiers.
- State calculated from dates: active, reminder, grace, suspended, exempt.
- Manual override, notes, and audit history.
- Immutable entitlement/payment events plus current materialized state. Store
  monetary values as integer minor units with explicit currency and timezone.

CSV import/export is required for migration and operator editing, but the
billing database becomes the source of truth. Google Sheets synchronization can
remain a later optional adapter.

### Inventory Management UI And API

- Add an authenticated **Services** workspace in `hosting-billing` with
  responsive create, view, edit, archive, search, and state-filter workflows.
- Allow operators to edit the primary domain, aliases, customer/contact
  details, hosting location/provider, hosting and domain paid-through dates,
  separate renewal periods, separate prices, currency, grace period,
  enforcement mode, manual override, timezone, and notes.
- Validate domain uniqueness, aliases, ISO dates, integer minor-unit prices,
  bounded periods, supported currencies, and local-versus-remote enforcement
  compatibility on the server. Do not trust browser validation.
- Use optimistic concurrency or an `updated_at` precondition so two browser
  sessions cannot silently overwrite each other.
- Show a preview of the calculated hosting/domain state before saving a date or
  policy change. Record old and new bounded values in audit history.
- Do not allow a domain change to create a second billing identity. Preserve
  the stable service ID, event history, payments, and public renewal identity.
- Add explicit manual actions for `exempt`, `resume`, and `suspend`, with a
  reason and audit entry. Manual suspension must still obey the global
  enforcement safety switch.

### WooCommerce Integration

- Use one hidden virtual **Hosting renewal** product, not one variation per
  domain and duration.
- Create orders/payment links with custom metadata: service ID, domain, period,
  amount, currency, and resulting renewal date.
- Receive signed WooCommerce webhooks, verify HMAC signatures, process
  idempotently, reject expired/replayed deliveries, and retain bounded
  payment/audit references.
- Handle refunds, chargebacks, partial payments, duplicate callbacks, and
  WooCommerce/API outages without silently extending or suspending service.
- Restore service immediately after a verified successful payment when policy
  permits.

### Hosting And Domain Renewal Orders

- Let the operator create a payment for **hosting**, **domain**, or **both**.
  Display each selected line item, renewal period, resulting paid-through date,
  and total before creating the WooCommerce order.
- Extend only the dates represented by verified paid order metadata. Combined
  payments update both dates atomically after amount and currency validation.
- Store separate hosting and domain renewal months. Migrate the existing
  `renewal_months` value to hosting renewal months without changing imported
  dates or prices.
- Keep one active order per service and renewal selection, or replace it only
  through an explicit audited cancellation. Expired links may be regenerated.
- Treat partial payments, changed WooCommerce totals, refunds, chargebacks,
  deleted products, and ambiguous webhooks as manual-review states. They must
  not automatically restore or extend a service.

### Public Renewal Page

- Add an unauthenticated renewal page on the configured public billing origin,
  for example `/renew/<opaque-service-reference>`. The URL must contain no
  client email, phone number, name, order key, or reusable administrator
  credential.
- Generate the public reference from a stable service ID plus a keyed,
  rotation-aware signature, or use an equivalently protected random identifier.
  Do not expose a plain domain parameter as the authority for selecting a
  billing record.
- Display only the website domain, current service state, selected renewal
  items, periods, prices, currency, and a secure WooCommerce payment action.
  Never expose internal notes, contact data, provider credentials, or audit
  history.
- Reuse a valid pending WooCommerce order. Create or refresh overdue payment
  orders through an authenticated scheduler/reconciler, not an unrestricted
  public GET request that bots could use to generate orders.
- If WooCommerce is unavailable or no valid order exists, show a bounded
  operator-contact message and keep retrying through the controlled scheduler.
- Apply strict CSP/security headers, request throttling, no-store caching, and
  generic error responses. Public payment lookup must not reveal whether
  arbitrary service IDs exist.

### Enforcement

- For locally hosted sites, enforce reminder/grace/suspended state at
  `hosting-nginx` so WordPress, generic PHP, and static sites behave consistently.
- Preserve a signed payment URL, manual exemption, and immediate rollback of
  the suspension rule.
- Remote sites require provider adapters, a WordPress plugin, or
  notification-only mode. Local nginx cannot suspend externally hosted sites.
- Never delete website data because payment expired.
- Billing never writes nginx files or calls Docker directly. It publishes
  signed entitlement state; a narrow hosting-side reconciler owns local
  enforcement and rollback.
- Use last-known-good entitlement state and fail open during billing-service
  outages. Suspension requires fresh verified state and an operator-configured
  grace policy.

### Hosting-Side Enforcement Reconciler

- Extend the existing signed entitlement observer with a separate, narrowly
  scoped reconciler. Billing remains unable to write nginx files, access
  Docker, or modify websites.
- Add a global **Enable billing enforcement** switch that defaults to off, plus
  an explicit pilot allowlist. A service is blocked only when all of these are
  true:
  - the global switch is enabled;
  - the service is on the local host and in the allowlist;
  - its per-service enforcement mode is `payment_page`;
  - a fresh HMAC-verified entitlement says `suspended`;
  - a valid public renewal URL is present;
  - the local domain maps unambiguously to that billing service.
- Render an atomic nginx host-to-renewal map. The common website server block
  should return a temporary redirect to the billing renewal page for blocked
  hosts. WordPress, static, generic PHP, and OpenCart sites should use the same
  mechanism without modifying application files or databases.
- Validate candidate nginx configuration before promotion and reload. On
  validation or reload failure, restore the previous map and report a critical
  operator notification.
- Add a freshness watchdog. If the signed snapshot becomes stale, malformed,
  unavailable beyond the configured threshold, or ambiguous, clear affected
  enforcement entries and reload nginx. The failure mode is always open.
- Keep NPM, the billing hostname, WooCommerce checkout/webhook paths, panel
  service hosts, health checks, and ACME operations outside the website
  suspension mechanism.
- Add **Preview changes**, **Reconcile now**, and **Disable and restore all**
  actions. Disabling enforcement must immediately empty the managed map without
  deleting data or changing paid-through dates.
- After a verified `processing` or `completed` webhook, billing should request
  a narrow authenticated observer refresh. The hosting reconciler should
  restore the website after receiving fresh signed active state, with periodic
  polling as a fallback.
- Log each proposed/applied block and restore with service ID, domain, state,
  snapshot generation, reason, and result. Never log payment tokens, order
  keys, client details, or provider secrets.
- Remote/shared-hosting records remain notification-only until a separately
  reviewed provider adapter exists.

### Remote WordPress Enforcement Plugin

- Add a separately versioned WordPress plugin for websites hosted outside
  OPI5. Prefer a normal managed plugin with a minimal MU-plugin loader so the
  enforcement bootstrap remains active across ordinary plugin deactivation and
  updates. Document that a hosting administrator with filesystem access can
  always remove it; this is billing presentation, not tamper-proof DRM.
- Do not authorize a remote site merely because its current domain matches a
  billing record. Domain ownership can change, staging copies can reuse a
  database, and cloned WordPress installations can retain old options.
- Add an explicit enrollment workflow:
  1. Select a remote WordPress billing service in the Billing UI.
  2. Generate a short-lived, one-time enrollment code.
  3. Enter the code in the plugin settings while authenticated as a WordPress
     administrator.
  4. Billing validates the expected canonical domain and records a generated
     site installation ID.
  5. Exchange the code for a revocable per-installation credential; never
     return the enrollment code again.
- Store only a hashed/revocable credential server-side. Keep the plugin
  credential in a protected WordPress option and never include it in URLs,
  logs, support bundles, telemetry, or portable billing CSV exports.
- Use a narrow remote API that returns only the service state, freshness,
  renewal-page URL, display-safe price/period details, and key-rotation
  metadata. It must not expose client contact details, internal notes,
  WooCommerce order keys, other services, or billing administration.
- Sign entitlement responses with an asymmetric key so distributing the plugin
  verification key does not distribute a server signing secret. Support
  overlapping public keys during controlled rotation.
- Poll outbound over HTTPS on a bounded interval and after relevant WordPress
  admin/page requests. Use WP-Cron or Action Scheduler as a convenience, but do
  not assume low-traffic sites execute WP-Cron reliably. Show the last
  successful verification and next retry in Site Health.
- Fail open when entitlement is missing, expired, has an invalid signature,
  uses an unsupported contract version, changes to an unapproved domain, or
  cannot be refreshed within the configured freshness window. Retain bounded
  diagnostics for the operator without exposing credentials.
- When a fresh signed entitlement is `suspended` and remote enforcement is
  enabled for that service, intercept public frontend requests early and render
  a small local suspension page containing the central protected renewal link.
  Keep WordPress administrator login, authenticated administration, WP-Cron,
  Site Health, the enrollment endpoint, and required payment-status polling
  available so the site can be repaired and restored.
- Do not modify the active theme, page content, menus, database URLs, or
  customer files. Suspension state belongs only to the plugin's protected
  options and can be rolled back immediately.
- On transition into or out of suspension, purge known WordPress page caches
  and request a narrowly scoped Cloudflare cache purge where configured.
  Document that upstream shared-host caches outside WordPress control can delay
  enforcement or restoration and must be qualified per provider.
- After a verified payment, the next successful signed poll must restore the
  public site automatically. Provide an authenticated **Check billing now**
  action for immediate recovery when WP-Cron is delayed.
- Add heartbeat visibility to the Billing UI: installation ID, approved
  canonical domain, plugin version, WordPress/PHP compatibility, last
  successful check, current applied state, and bounded error. Do not collect
  visitor analytics, content, user lists, or unrelated site data.
- Support credential revoke/re-enroll, domain-change approval, staging-copy
  detection, and uninstall cleanup. A cloned installation must fail open and
  request re-enrollment rather than sharing enforcement identity.
- Publish signed plugin packages with checksums and a controlled update
  channel. Automatic updates remain opt-in until rollback and compatibility are
  tested against supported WordPress/PHP versions.
- Non-WordPress remote websites remain notification-only until separate,
  least-privilege adapters are designed. Do not reuse WordPress credentials for
  arbitrary PHP, OpenCart, cPanel, or shared-hosting control.

### Provisioning Billing Defaults

- Add configurable billing defaults to the hosting panel rather than
  hard-coding commercial policy in the provisioner. Initial defaults requested:
  - create a billing record for every successfully provisioned website;
  - six free months from the successful provisioning date;
  - next hosting renewal: 12 months;
  - hosting price: USD 80.00 (`8000` minor units);
  - domain price/date empty unless the operator purchased the domain;
  - local provider/location;
  - enforcement mode `payment_page`, while global enforcement remains off
    until qualification.
- Show these values in **Settings > Billing provisioning defaults** and allow
  changing enabled state, free months, renewal months, price, currency, grace
  days, and default enforcement mode.
- Add a provisioning-page checkbox, enabled from the configured default, to
  create the billing record. Show the calculated first paid-through date,
  future price, and period before the site job is submitted.
- Register billing only after website provisioning has reached a successful or
  explicitly accepted partial-success state. Use an idempotency key tied to the
  provisioning job so retries cannot create duplicate services.
- Add a narrow bearer-authenticated internal billing endpoint for idempotent
  service creation. It should accept only bounded provisioning fields and must
  not expose general billing administration.
- A billing registration failure must not delete or roll back a working
  website. Mark the provisioning job partially successful, notify the operator,
  and provide a retry action.
- Imported or restored websites should offer the same billing-registration
  choice but must not receive a fabricated free period unless the operator
  explicitly selects it.

### Remaining Delivery Phases

1. Implement and test schema migrations plus authenticated inventory CRUD.
   Import the current CSV into the migrated model and verify that all existing
   IDs, dates, prices, payments, and audit records remain intact.
2. Implement separate hosting/domain order calculations and the protected
   public renewal page. Keep enforcement disabled.
3. Add configurable six-month-free provisioning defaults and idempotent
   internal service registration. Qualify new-record creation with a disposable
   test website.
4. Qualify payment links and webhooks with the real hidden WooCommerce test
   product: checkout, processing/completed, duplicate delivery, expiration,
   mismatched amount/currency, refund, chargeback, and provider outage.
5. Implement the nginx map reconciler behind a global off switch. Test stale
   snapshots, invalid signatures, ambiguous aliases, nginx validation failure,
   billing outage, WooCommerce outage, panel restart, and immediate global
   rollback.
6. Pilot only `testsite.mishaweb.com`. Exercise active, reminder, grace,
   suspended, payment, automatic restore, manual exemption, and disable-all
   workflows before adding any production domain to the allowlist.
7. Build the remote WordPress plugin and enrollment API after local enforcement
   passes. Pilot one disposable remote WordPress site through enrollment,
   cloning, stale-state, suspension, payment, cache purge, restoration,
   credential revoke, and plugin rollback tests.
8. Review audit logs, notification behavior, load, and rollback evidence.
   Enable selected production services individually; never bulk-enable the
   imported inventory during the pilot.

### Acceptance Criteria

- Provider outage or stale state cannot suspend an otherwise active service.
- Duplicate/replayed payment events cannot extend service twice.
- Payment URLs contain no customer PII or reusable credential.
- Enforcement can be disabled globally and reverted immediately without
  deleting website data.
- No imported or existing website is blocked merely because the feature was
  deployed. Global enforcement and the pilot allowlist both default to empty.
- A verified payment restores an allowed local website without manual nginx,
  NPM, database, or filesystem edits.
- Hosting-only, domain-only, and combined payments update exactly their selected
  paid-through dates.
- New successful provisions create exactly one billing record with the
  configured defaults; retries remain idempotent.
- Inventory edits are validated, concurrency-safe, audited, backed up, and
  represented in canonical CSV export.
- A remote WordPress site cannot enroll or suspend itself based only on a
  matching domain, and a cloned database cannot reuse another installation's
  enforcement identity.
- Invalid, stale, revoked, unavailable, or incompatible remote entitlement
  state fails open; a fresh verified payment restores the remote frontend
  without theme or content changes.

## 2. Separate Mail Platform

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

- Treat inbound TCP 25 reachability, static WAN addressing, PTR/rDNS control,
  SES production access/quota, and an abuse-response process as hard go/no-go
  gates before building or migrating production mail.
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
- Define the SES event receiver and durable transport explicitly (for example
  SNS to SQS consumed by `mail-control`) with signature verification,
  deduplication, replay handling, and bounded retention.
- Add inbound spam and malware controls, outbound anomaly limits, automatic
  account containment, TLS/certificate rotation, and privacy-aware log
  retention before the pilot.

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

The read-only two-phase host/AWS feasibility preflight is implemented in
`scripts/mail-feasibility.sh` and documented in `docs/MAIL_FEASIBILITY.md`.
It intentionally does not claim inbound reachability, static IP ownership, PTR
control, abuse readiness, or production qualification without independent
evidence.

The current target-host preflight has no hard failures: supported architecture,
storage, local port availability, outbound SES connectivity, and clock
synchronization pass. Static-address ownership, the final mail hostname/PTR,
independent inbound reachability, abuse procedures, and authenticated SES
account gates remain unresolved and therefore stay in this backlog.

1. Resolve every preflight failure and warning. Measure account count, total
   mailbox storage, growth, aliases, and source migration capabilities; confirm
   public port 25/587/993 reachability from an independent Internet host.
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

## 3. Warm Standby And Controlled Failover

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
- Define and test exact replication mechanisms for NPM state/certificates,
  panel state, encryption keys, agent secrets, and active runtime
  configuration. Never copy live databases as ordinary files.
- Do not replicate active/running job state as runnable work. The standby
  records interrupted work and requires reconciliation after promotion.
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

- Define numeric per-state RPO/RTO targets before implementation. Planned
  promotion and failback must meet them without
  split-brain.
- WordPress writes, NPM state/certificates, panel integrations, files, and
  scheduled work are correct after promotion.
- DNS rollback and emergency manual recovery remain possible if automation
  fails.

Before live replication, complete a documented restore of the current stack
onto an isolated replacement host using local plus encrypted off-site backups.
Verify recovery keys, websites, databases, NPM hosts/certificates, panel state,
and an operator login. Replication is not a substitute for versioned backups
because deletion, corruption, or compromise can replicate too.

The bounded local qualification in `scripts/qualify-local-recovery.sh` now
validates and extracts the latest app-data archive and restores one
representative website database into a resource-limited, no-network temporary
MySQL container. This is useful continuous evidence, but it does not satisfy
the replacement-host requirement above; the full coordinated restore,
application checks, NPM/certificate validation, operator login, RPO/RTO, and
DNS rollback drill remain outstanding.

## Cross-Cutting Delivery Rules

- Every long panel operation returns a durable job ID, survives browser
  disconnects, uses conflict classes, and supports cancellation only at
  coherent safety checkpoints.
- Separate billing and mail services own their durable queues and data. The
  hosting panel observes them through authenticated APIs rather than receiving
  their database, filesystem, Docker, or shell privileges.
- Keep standalone recovery scripts, but panel-triggered equivalents must use the
  same managers and compatible result records.
- Remove legacy per-manager status files only after every workspace reads shared
  job state and useful history has an explicit migration.
- Schema and state migrations are versioned, idempotent, reversible where
  practical, and preceded by a verified backup for destructive changes.
- Notifications continue to support independent external SMTP and Telegram.
  The future local mail platform is not a dependency of control-plane alerts.
- Do not send archives through Telegram or place credentials, private keys,
  customer data, production domains, or live screenshots in Git, jobs, logs, or
  portable manifests.
- New containers use pinned tested multi-architecture versions, least privilege,
  no unnecessary host ports, bounded resource usage, health checks, security
  documentation, and restore-tested persistent state.

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
