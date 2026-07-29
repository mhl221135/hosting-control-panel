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
handling. Billing remains unable to enforce directly; the independently gated
hosting-side reconciler is described below. Live payment qualification against
the dedicated hidden renewal product is still required before client use.

Renewal reminders are implemented with a disabled-by-default daily scheduler,
due-state preview, manual run, durable idempotent outbox, failure retry, and a
narrow bearer-authenticated adapter to the existing Telegram/SMTP delivery
queue. Billing has no access to notification credentials or panel data.

The hosting panel now has a disabled-by-default entitlement consumer and local
nginx map reconciler. It verifies HMAC, freshness, unique domain ownership, and
opaque renewal URLs; compares billing with local primary websites; and fails
open unless the global switch, explicit pilot allowlist, `payment_page` policy,
fresh `suspended` state, and local ownership all agree. The switch defaults off
and the allowlist defaults empty. Production use remains blocked on the
dedicated test-service pilot.

### Data Model

- Stable service ID with one primary domain and optional aliases. Domains are
  mutable attributes, not database keys.
- Customer/contact details.
- Hosting location/provider: local stack, remote shared hosting, or
  notification-only.
- Add free-trial origin and explicit trial metadata. The implemented inventory
  already stores separate hosting/domain dates, periods, and prices plus
  currency, grace policy, enforcement mode, creation timestamps, and an
  archived flag.
- WooCommerce order/payment identifiers.
- State calculated from dates: active, reminder, grace, suspended, exempt.
- Manual override, notes, and audit history.
- Immutable entitlement/payment events plus current materialized state. Store
  monetary values as integer minor units with explicit currency and timezone.

CSV import/export is required for migration and operator editing, but the
billing database becomes the source of truth. Google Sheets synchronization can
remain a later optional adapter.

### WooCommerce Integration

- Use one hidden virtual **Hosting renewal** product, not one variation per
  domain and duration.
- Create orders/payment links with custom metadata: service ID, domain, period,
  amount, currency, and resulting renewal date.
- Receive signed WooCommerce webhooks, verify HMAC signatures, process
  idempotently, reject expired/replayed deliveries, and retain bounded
  payment/audit references.
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
- Billing never writes nginx files or calls Docker directly. It publishes
  signed entitlement state; a narrow hosting-side reconciler owns local
  enforcement and rollback.
- Use last-known-good entitlement state and fail open during billing-service
  outages. Suspension requires fresh verified state and an operator-configured
  grace policy.

### Remaining Hosting-Side Enforcement Work

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

- Add `payment_page` as a provisioning enforcement default only after global
  enforcement and the pilot allowlist pass qualification. Implemented
  registrations deliberately use `none`.

### Remaining Delivery Phases

The read-only `scripts/qualify-billing-pilot.sh` gate is implemented. It
validates one exact local pilot across billing policy, signed snapshot
freshness, allowlisting, nginx mapping, renewal presentation, matching payment
amount, renewal-page security headers, and WooCommerce checkout without
exposing protected URLs. A suspended state qualification has been exercised
against one operator-selected local service. This is not evidence of
completed-payment restoration or the remaining state/outage drills below.

1. Qualify payment links and webhooks with the real hidden WooCommerce test
   product: checkout, processing/completed, duplicate delivery, expiration,
   mismatched amount/currency, refund, chargeback, and provider outage.
2. Qualify the disabled-by-default reconciler and immediate post-payment
   refresh through billing outage, WooCommerce outage, callback retry, polling
   fallback, panel restart, nginx rollback, notification-delivery, and
   freshness-watchdog drills.
3. Pilot only the dedicated test website. Exercise active, reminder, grace,
   suspended, payment, automatic restore, manual exemption, and disable-all
   workflows before adding any production domain to the allowlist.
4. Build the remote WordPress plugin and enrollment API after local enforcement
   passes. Pilot one disposable remote WordPress site through enrollment,
   cloning, stale-state, suspension, payment, cache purge, restoration,
   credential revoke, and plugin rollback tests.
5. Review audit logs, notification behavior, load, and rollback evidence.
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
- Store the effective role and unique server identity in a local durable marker
  outside every replicated path. Replication must never overwrite a standby
  role with the primary role.
- Keep machine-local `.env`, storage paths, backup retention, performance
  limits, WAN addresses, and role policy separate. Do not synchronize them from
  the primary.

### Role-Aware Panel And API

- In `standby` mode, replace the normal operational navigation with
  **Overview**, **Replication**, **Received backups**, **Health**,
  **Promotion**, **Settings**, **Account**, and bounded read-only logs.
- Hide or visibly disable **Provision**, **Maintenance**, WordPress updates,
  image optimization, site removal, Cloudflare changes, NPM/certificate
  changes, cache controls, local backup scheduling, package deployment, import,
  and every other action that can mutate hosted service state.
- UI hiding is not an authorization boundary. Every corresponding server API,
  background scheduler, Telegram command, startup task, and job worker must
  check the local role and reject or suppress mutating work while the role is
  `standby`.
- Keep read-only website inventory, replication status, received-backup
  verification, database lag, filesystem recovery point, source commit,
  configuration compatibility, disk capacity, and promotion readiness visible.
- Clearly label the standby header and browser title so an operator cannot
  mistake it for the active primary.
- Do not enqueue disabled jobs and do not retain primary jobs as runnable work.
  Show replicated/interrupted jobs as historical evidence only.

### Independent Retention And Resource Profiles

- Configure backup retention per destination. Initial requested policy is seven
  completed sets on the primary and three received, checksum-verified sets on
  the replica.
- Do not mirror backup deletions. The replica receives only completed sets into
  staging, verifies manifests/checksums/archive integrity, atomically promotes
  them, and applies its own retention after a newer usable set exists.
- Add role-specific performance profiles and explicit overrides. An 8 GB
  standby must not inherit the 16 GB primary's MySQL, Redis, OPcache, PHP-FPM,
  or cache settings.
- While in standby mode, run only replication, verification, health, and the
  minimum internal services required for readiness. Redis and FastCGI cache are
  disposable and should remain empty; PHP/public nginx may remain stopped until
  promotion.
- Provide a tested `standby-8gb` promotion profile with conservative initial
  limits, then allow operator tuning after measured load. Promotion must
  validate available memory and disk before starting the full stack.

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

### Direct NPM And Cloudflare Tunnel Ingress

- Support an explicit public-ingress mode per server:
  - `direct_npm`: Cloudflare/DNS origin records target the public WAN address
    and traffic enters NPM on ports 80/443;
  - `cloudflare_tunnel`: outbound `cloudflared` connects to Cloudflare and
    published website hostnames route directly to `hosting-nginx:80` on the
    internal Docker network.
- Allow a primary or promoted replica behind CGNAT/gray IP to use tunnel mode
  without exposing inbound 80/443. The host still requires reliable outbound
  HTTPS/QUIC connectivity to Cloudflare.
- Run a dedicated pinned multi-architecture `hosting-cloudflared` container
  with no host ports, no Docker socket, dropped capabilities, read-only root
  filesystem, bounded resources, health reporting, and a separately stored
  tunnel credential. Never commit the tunnel token or generated credentials.
- Treat NPM and Tunnel as alternative website ingress transports, not a proxy
  chain. Tunnel website routes should forward to `hosting-nginx:80`; they must
  not loop through public NPM. NPM may remain available internally for
  administration and direct-mode rollback.
- Add **Ingress** settings showing current mode, tunnel/account identity,
  connector health, connected replicas, routed hostnames, DNS state, and the
  last successful reconciliation. Use a separate least-privilege Cloudflare
  token for tunnel and DNS management.
- Add per-site eligibility and selection. Tunnel automation is available only
  for zones controlled by the configured Cloudflare account. External DNS
  providers and unsupported zones require a documented manual adapter and must
  not be silently changed.
- Before switching a hostname to tunnel mode:
  1. verify the local website and canonical aliases;
  2. verify `hosting-cloudflared` is connected and healthy;
  3. create or idempotently update the Cloudflare Tunnel public-hostname route;
  4. test the route through a non-public qualification hostname;
  5. preview the exact DNS replacement and ownership;
  6. save the previous DNS type/content/proxy/TTL as a rollback record;
  7. replace only confirmed managed `A`, `AAAA`, or `CNAME` records with the
     proxied tunnel target;
  8. validate public HTTP, HTTPS, redirects, WordPress admin, uploads,
     WebSockets where used, and restored client IP handling.
- Do not request or attach an NPM/Let's Encrypt origin certificate for a
  tunnel-only website. Cloudflare terminates public TLS; the internal tunnel
  transport remains private. Direct mode retains the existing NPM certificate
  workflow.
- Preserve the original `Host`, external HTTPS scheme, and real visitor
  address. Qualify `CF-Connecting-IP` restoration and trusted-proxy boundaries
  so WordPress URLs, logs, rate limits, billing enforcement, and security rules
  behave the same in both ingress modes.
- Provide **Preview switch**, **Switch selected hosts**, **Verify**, and
  **Rollback** actions. Operations must be idempotent, durable, auditable, and
  resumable after browser or panel restart.
- Never bulk-replace unrelated DNS records. Record ownership for routes and DNS
  changes, reject ambiguous pre-existing records, preserve MX/TXT/CAA and other
  non-ingress records, and require explicit confirmation before taking over a
  hostname managed by another tunnel.
- During promotion, select the target ingress mode after local service
  validation:
  - public-IP replica: use reviewed direct NPM origin changes;
  - gray-IP replica: require a healthy tunnel and switch selected hostnames to
    their tunnel routes.
- Keep the former primary fenced even when traffic moves through a tunnel.
  Remove or disable its connector/routes and revoke obsolete tunnel or DNS
  authority so two servers cannot both act as the active origin.
- Support a later controlled switch from tunnel back to direct NPM. Restore the
  reviewed WAN-origin records, verify NPM TLS and public traffic, then remove
  obsolete tunnel hostname routes. Never destroy the rollback record before
  successful verification.

### Disconnect And Permanent Promotion

- Provide two explicit workflows:
  - **Planned detach and promote** while both servers are reachable;
  - **Emergency promote** when the primary is permanently unavailable.
- Planned promotion must stop or fence new writes on the primary, wait for
  MySQL GTID and filesystem replication to reach a recorded common recovery
  point, verify local app data/NPM state, stop replication, and only then make
  the standby writable.
- Emergency promotion must not depend on an API response from the failed
  primary. It uses the newest locally verified database/files/app-data recovery
  point, displays the measured data-loss window, and requires the operator to
  confirm that the old primary has been fenced through power, networking,
  router, DNS, or credential revocation.
- Before promotion, run a blocking preflight covering:
  - local role/server identity and promotion lock;
  - source commit and schema/config compatibility;
  - MySQL integrity, GTID position, lag, and read-only state;
  - filesystem sync completion and absence of partial transfers;
  - NPM database/certificate consistency;
  - required encryption keys and machine-local secrets;
  - available memory, disk, ports, and the selected performance profile;
  - nginx/PHP configuration validation;
  - Cloudflare/router cutover authority and rollback instructions.
- Promotion must be a durable, checkpointed job with an exact typed
  confirmation. It atomically changes the local role, disables incoming
  replication, makes MySQL writable, starts the selected services, validates
  local Host-header traffic, then enables schedulers and external integrations
  only at their designated checkpoints.
- A promoted replica becomes an independent `primary`. It must remove the old
  pairing, rotate/revoke replication credentials, allocate a new replication
  epoch, stop accepting pushes from the former primary, and never automatically
  reconnect or demote itself.
- Public traffic cutover remains an explicit step after local validation.
  Support reviewed Cloudflare origin changes and documented router/load-balancer
  changes, with the previous values retained for rollback.
- Provide **Abort before writable**, **Rollback before traffic cutover**, and
  **Complete promotion** states. After public writes begin, rollback means
  rebuilding another standby from the new primary; it must never reactivate the
  stale former primary.
- After promotion, show outstanding reconciliation: interrupted jobs, backup
  destination ownership, scheduled-task activation, notification identity,
  NPM/certificate checks, Cloudflare records, and the requirement to establish
  a new standby.

### Acceptance Criteria

- Define numeric per-state RPO/RTO targets before implementation. Planned
  promotion and failback must meet them without
  split-brain.
- WordPress writes, NPM state/certificates, panel integrations, files, and
  scheduled work are correct after promotion.
- DNS rollback and emergency manual recovery remain possible if automation
  fails.
- Standby mode cannot provision, maintain, update, delete, back up, issue
  certificates, modify DNS, or execute equivalent mutations through hidden
  APIs, schedulers, jobs, or Telegram commands.
- A replica can be permanently promoted with the old primary completely
  unreachable, provided the operator confirms external fencing and accepts the
  displayed recovery point.
- After promotion, no process can resume old incoming replication or overwrite
  the new primary with stale data.
- A gray-IP promoted replica can serve selected Cloudflare-managed websites
  through a healthy outbound tunnel without public host ports, and each DNS or
  tunnel-route change has an exact tested rollback to its prior ingress mode.
- Direct NPM and tunnel ingress preserve canonical hosts, HTTPS detection,
  uploads, supported WebSockets, and verified real-client IP behavior without
  exposing tunnel credentials or trusting arbitrary proxy headers.

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
