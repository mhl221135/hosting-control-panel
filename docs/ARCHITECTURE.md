# Architecture

## System Boundary

The stack is a control plane around shared WordPress runtime services. It is not
a container-per-site platform. Isolation is provided by separate PHP-FPM pools,
document roots, database users, nginx routing, and PHP `open_basedir` settings.

```text
Public client
  -> hosting-npm :80/:443
  -> hosting-nginx :80 (Docker network only)
  -> per-site listener in hosting-php-fpm
  -> hosting-db and optional hosting-redis

Administrator
  -> hosting-ui :8687
     -> active config mounts
     -> authenticated hosting-agent API
     -> NPM HTTP API
     -> Cloudflare HTTP API

hosting-agent (no host port)
  -> server-side command policy
  -> Docker socket

Billing administrator
  -> hosting-billing :8787
     -> isolated SQLite inventory
     -> signed read-only entitlement API
     -> dedicated verified backups
```

## Service Ownership

| Container | Responsibility | Host ports | Persistent data |
|---|---|---|---|
| `hosting-ui` | Panel, scheduler, provisioning, integrations | `8687` | `app-data/ui-manager` |
| `hosting-agent` | Allowlisted runtime operations over Docker | none | none |
| `hosting-billing` | Renewal inventory, audit, signed entitlement API | `8787` | `app-data/billing`, `backups/billing` |
| `hosting-npm` | Public reverse proxy and ACME | `80`, `81`, `443` | `app-data/npm` |
| `hosting-nginx` | Internal site routing and FastCGI cache | none | config mounts, `app-data/nginx-cache` |
| `hosting-php-fpm` | PHP 8.4 pools, WP-CLI, image conversion | none | website and config mounts |
| `hosting-db` | MySQL 8.4 for NPM and websites | none | `app-data/mysql` |
| `hosting-redis` | Optional WordPress object cache | none | `app-data/redis` |
| `hosting-files` | File Browser over website roots | none | `app-data/filebrowser` |
| `hosting-phpmyadmin` | Database administration | `8484` | none |

All stack containers use the explicit Docker bridge network `hosting-net`.
Database and Redis ports are intentionally not published.

`hosting-billing` is a separate control-plane boundary. It has no Docker
socket, website, MySQL, nginx, or panel-data mount and cannot mutate hosting
state. `hosting-ui` receives only its internal URL and bearer token for narrow
provisioning, reminder delivery, signed entitlement observation, and guarded
local enforcement. See `BILLING.md`.

## Runtime Routing

`sites.map` records one host, document root, upstream, and optional canonical
target per row. `runtime-config.js` parses and renders this file. Internal nginx
uses the host to choose both the root and PHP-FPM upstream. `pools.conf` defines
the matching listener and process limits.

`billing-enforcement.map` is an independent fail-open host-to-renewal map. It
is empty by default and is owned only by the hosting-side billing reconciler.
The common nginx server redirects a listed host before application routing, so
WordPress, OpenCart, generic PHP, and static sites share one mechanism. Billing
publishes signed state but cannot write or reload nginx. The hosting-side
manager keeps a bounded transition audit and sends critical nginx failures to
the existing notification queue without persisting renewal URLs.

A primary site and its aliases normally share the same document root and
PHP-FPM listener. A canonical redirect from `www` to the primary host is added
when configured. The panel groups rows with the same root and pool so aliases
are not presented as independent websites.

## Panel Process

`server.js` uses Node's built-in HTTP server. It initializes long-lived stores
and managers, serves `/app/public`, authenticates API calls, and dispatches API
routes. It does not use Express; Nodemailer is the only runtime npm dependency.

The container runs as UID/GID `33:33`, drops all Linux capabilities, and uses
`no-new-privileges`. `/srv/app-data` is read-only. Writable mounts are limited
to `/app/data`, active configuration, websites, backups, exports, and imports.
The host-side install/upgrade migration grants ownership only to those managed
trees and does not recursively change existing website ownership.

The `docker` executable in `hosting-ui` is an RPC compatibility shim, not the
Docker CLI. It streams requests to `hosting-agent` with
`HOSTING_AGENT_TOKEN`. The agent validates container names, users, environment
keys, executables, paths, and command shapes before its Docker CLI touches the
socket. It exposes no host port and cannot be asked to create containers, pull
images, mount paths, or run commands in arbitrary containers.

| Module | Owns |
|---|---|
| `auth.js` | scrypt account hash, sessions, throttling, cookies |
| `job-manager.js` | durable queue, conflict scheduling, recovery, cancellation, retries, bounded history |
| `integration-settings.js` | AES-256-GCM secrets and environment fallback |
| `integrations.js` | NPM, ACME, Cloudflare DNS and Security clients |
| `certificate-job-manager.js` | durable NPM certificate issuance/renewal with ownership revalidation |
| `runtime-config.js` | nginx host map and PHP pool parsing/rendering |
| `provisioner.js` | WordPress files, database/user, WP-CLI operations |
| `provision-security.js` | capability validation and warning-safe Cloudflare hardening step |
| `cloudflare-automation-manager.js` | bulk dry-runs/jobs/rollback, provisioning defaults, temporary mitigation lifecycle |
| `wordpress-maintenance.js` | allowlisted low-priority WP-CLI cleanup, bounded revisions, and read-only version inventory |
| `maintenance-manager.js` | persisted manual/weekly maintenance plus durable inventory jobs |
| `wordpress-update-manager.js` | persistent exclusions, immutable update previews, verified backups, health checks, and automatic rollback |
| `site-state.js` | Redis, OPcache, FastCGI, backup and image-schedule switches |
| `backup-manager.js` | schedule, locks, archives, retention, restore |
| `migration-manager.js` | portable export/import and runtime adoption |
| `performance-settings.js` | validated managed configuration directives |
| `dns-presets.js` | reusable Cloudflare record templates |
| `wordpress-packages.js` | uploaded plugin/theme ZIP library |
| `provision-import-store.js` | streamed import staging and archive normalization |
| `stats-collector.js` | on-demand runtime and traffic summaries |
| `image-optimization-manager.js` | persistent sequential WebP job state and daily scheduler |

The billing service has a separate composition root and modules under
`billing-service/app`. `database.js` owns schema and transactional inventory,
`csv.js` owns migration formats, `auth.js` owns its independent account and
sessions, `woocommerce-settings.js` owns encrypted provider settings,
`payments.js` owns link/webhook policy, and `backups.js` owns SQLite snapshot,
verification, and restore. Provider callbacks can change only billing service
state; there is no hosting enforcement adapter.

`reminders.js` owns the disabled-by-default daily scheduler and durable billing
outbox. It sends an allowlisted contract to one bearer-authenticated internal
`hosting-ui` endpoint. `billing-notification-api.js` reconstructs the operator
message and passes it to the existing notification queue; billing never sees
notification credentials. `billing-entitlement-observer.js` is the inverse
read-only adapter in `hosting-ui`: it verifies signed entitlement snapshots,
retains a last-known-good copy, and reports local inventory drift.
`billing-enforcement.js` consumes only that verified view, owns the narrow
fail-open nginx map and rollback, and records bounded transition evidence.
After a durable verified payment, billing's bounded refresh client sends only
the provider delivery ID to `hosting-ui`; the panel independently refreshes the
signed feed and reconciles. Scheduled observation is required while enforcement
is armed and provides the callback-failure fallback.

The separately packaged `wordpress-plugin/hostpilot-remote` is the remote
consumer for WordPress sites outside the stack. It exchanges a one-time code,
encrypts its installation credential with WordPress salts, verifies the narrow
Ed25519 contract, and retains only last-known-good safe state. It has no
frontend enforcement path in the current phase.

## Authentication And Secrets

The first panel account is created from `UI_ADMIN_EMAIL` and
`UI_ADMIN_PASSWORD`; its password is stored as an scrypt hash. Sessions are
in-memory, expire, and use an HTTP-only cookie, so a panel restart signs users
out. Mutating API calls require the session CSRF value.

NPM and Cloudflare secrets are encrypted with AES-256-GCM. The key comes from
`UI_SETTINGS_KEY`, or from a generated mode-600 key file. Losing both the
external key and generated key makes stored integration secrets undecryptable.
MySQL root credentials stay in the database container environment.

## Provisioning Transaction

Provisioning validates inputs before mutation, then:

1. prepares the website directory;
2. allocates or updates the PHP-FPM pool and nginx map row;
3. validates and reloads runtime services;
4. creates the required WordPress/OpenCart database or an optional Generic PHP database/user;
5. installs WordPress, imports and rewrites validated OpenCart, or installs validated Generic PHP/Static HTML files;
6. installs selected WordPress packages and optional Redis configuration;
7. applies optional Cloudflare DNS and DNS presets;
8. ensures the NPM proxy host and optional certificate;
9. persists per-site state.

External DNS/ACME operations can fail after local resources exist. These are
reported so an administrator can retry without deleting a valid site.

## Cache Layers

- **OPcache** is PHP bytecode memory shared by the PHP container. Per-site
  enablement is a pool directive; global limits are managed settings.
- **FastCGI cache** stores anonymous HTML at internal nginx. `cache.map` selects
  sites and a version number performs logical purge.
- **Redis** stores WordPress objects. Enabling it updates `wp-config.php` and
  installs/activates the Redis Cache plugin.
- **Image negotiation** serves smaller `.webp` sidecars when accepted.
  Negotiated JPEG/PNG URLs avoid shared caching so edge caches cannot mix formats.

## Background Jobs

`job-manager.js` persists jobs atomically in `/app/data/jobs.json`. Queued work
survives a panel restart; work that was running is marked failed because the
panel cannot prove that an interrupted external mutation completed. Named
conflict keys serialize CPU, storage, database, and per-site work while allowing
future independent operations to run concurrently. Cancellation is cooperative
and takes effect only when a handler reaches an explicit safe checkpoint.

The public API omits private handler payloads. Payloads with sensitive field
names are rejected before persistence, result/error text is bounded, and
terminal history is pruned to `JOB_HISTORY_LIMIT` without removing active work.
Backups, restores, WordPress maintenance and updates, image optimization,
website provisioning/import, exports/imports, certificate actions, Cloudflare
bulk automation, and website deletion use this queue. Legacy status files
remain compatibility views only where an existing workspace still reads them.

Website deletion also uses the queue and recalculates live resource ownership
inside the worker. It allows cancellation before backup and before the first
destructive mutation, then completes the selected destructive sequence without
interruption. Deletion jobs are intentionally non-retryable; a new live preview
is required after any partial external mutation.

`notification-manager.js` subscribes to terminal job events and creates one
deduplicated delivery record per job outcome. Telegram uses the Bot API and SMTP
uses a pinned Nodemailer transport. Failed channel attempts use bounded backoff
and survive panel restarts in `/app/data/notification-deliveries.json`; channel
state is copied onto the originating job for the UI. Notification credentials
are AES-256-GCM encrypted separately from delivery history, and provider
responses are not retained.

Each delivery channel inherits global severity filters by default or applies
its own failure, warning, and success selection. Channel eligibility is fixed
when the event is queued so retries preserve the original delivery targets.

`telegram-command-manager.js` optionally polls the same bot for read-only
operator commands. Both the chat and sender must be explicitly allowlisted.
The manager persists only its update cursor and bounded command audit metadata,
rate-limits each sender, and obtains status/site summaries through narrow
providers.

An independently disabled mutation mode maps `/backup` and `/purge` to narrow
callbacks owned by the server composition root. A random challenge is bound to
one chat/user pair in memory for two minutes and deleted before invoking the
operation. Backup uses the existing durable job path; purge performs only the
existing per-site FastCGI cache-version update and nginx reload. No command
manager path receives a shell, Docker, SQL, WP-CLI, or filesystem primitive.

Direct certificate issuance and renewal are durable jobs, so provider failures
reach the same terminal notification path as backups and provisioning. Renewal
revalidates the selected hostname/certificate relationship immediately before
calling NPM; certificate operations are serialized and are not blindly retried.

`health-monitor.js` runs a lightweight interval gate rather than collecting
continuous metrics. It checks core container and service state, attached NPM
certificate expiry, OPcache pressure, and storage thresholds. Active incidents
are reconciled by stable keys, so notifications are created only when an issue
opens, changes, or resolves. `/app/data/health-state.json` preserves active
state and bounded transition history across panel restarts.

Selected public hosts can also be checked through HTTPS with bounded concurrency
and timeout. Redirects are followed, bodies are cancelled immediately, and no
request/response content is persisted. Public checks are disabled until an
operator adds hostnames to health settings.

## Backup And Restore

The job scheduler serializes backups, restores, maintenance, and image work
through the `server-heavy` conflict class. The backup manager retains a
defensive internal lock for direct recovery calls. WordPress backups pair files,
a logical database dump, and a manifest. OpenCart always pairs its files and
state-declared database. Generic PHP does the same when its
panel state declares a database, otherwise it is file-only. Static HTML backups
are file-only sets with an explicit null database. Retention deletes complete
sets.

Restore validates ownership, creates a safety backup, stages the file swap on
the websites filesystem, imports the database, and attempts rollback on import
failure. Application-data restore remains manual because services must stop.

## Website Removal

Removal is an ownership-checked workflow, not a recursive delete shortcut. The
preview groups the primary host and aliases, verifies exclusive root and pool
use from runtime configuration, reads the selected WordPress database/user, and
checks those identifiers against every other primary site. It also checks NPM
host and certificate references and lists only exact Cloudflare A, AAAA, and
CNAME records for the site's hostnames.

The execute request requires typed domain confirmation and recalculates the
plan. Unsafe resources cannot be forced through request flags. The complete
operation holds the backup manager's storage lock. A final backup is enabled by
default, while historical backup deletion is a separate, incompatible choice.

## Migration

Exports are password-free manifests plus website archives, database dumps, and
SHA-256 checksums. The authenticated Transfers workspace previews primary sites
and queues `sites.export` work through the durable job manager. Export and
backup operations share the storage lock; per-site failures remain independent,
and cancellation occurs only between complete site bundles. Completed artifact
downloads are path-confined, reject symlinks, and enforce a configurable size
limit.
Imports support a full manifest, a lightweight `import-sites.json`, or discovery
from existing `wp-config.php` files. Import generates new database credentials
and rewrites `wp-config.php`; source credentials are never required.

The authenticated Transfers adapter lists manifest-bearing staged directories
under `imports`, resolves lightweight plans through the same manager used by the
CLI, and returns a read-only fingerprinted preview. It reports destination and
database blockers plus existing exact-host Cloudflare records and NPM hosts.
Execution requires a matching fingerprint and typed confirmation, then runs as
a non-retryable `sites.import` job under the shared storage lock. The job
revalidates the source and refuses any existing configured domain, non-empty
archive destination, or database before mutation.

Staging cleanup is a separate `sites.import-cleanup` job with the same
`storage:imports` conflict key. It requires exact-source typed confirmation and
revalidates that the target is a direct, real, manifest-bearing child of the
imports root before recursive removal. Website and database mounts are outside
that deletion boundary.

Complete browser bundles reuse `ProvisionImportStore`'s ordered chunk and
server-offset protocol. The UUID and committed offset are retained in browser
session state so reselecting the same file resumes rather than restarts.
Finalization is a `sites.import-upload-stage` job, not a long HTTP request. It
path-validates archive listings, rejects symlinks after extraction, requires one
manifest, validates every referenced artifact against `checksums.sha256`, and
atomically publishes `upload-<uuid>` as a normal staged source. Failed upload
workspaces expire after 24 hours.

The Provision tab's single-site adapters stage raw uploads below
`imports/ui-provision`, validates archive member paths, rejects symlinks, finds
the sole WordPress document root when applicable, and normalize optional Generic
PHP dumps independently of WP-CLI. This keeps browser imports on the same
database/runtime rollback path as host-level imports. The final transaction is
a `site.provision` durable job with site/runtime/heavy-work conflicts and safe
cancellation checkpoints before irreversible changes. Core import work runs
under the shared storage-operation lock; external integration failures are
reported as warnings after the site is usable. Generated credentials live only
in an AES-256-GCM encrypted one-time vault, never in persisted job records.
Those integration warnings are failed sub-results, so the durable job resolves
as partially succeeded and can trigger warning notifications.

`site-capabilities.js` is the central adapter registry. WordPress requires a
database and supports Redis, OPcache, FastCGI, and image optimization. OpenCart
requires a database and supports OPcache plus commerce-safe FastCGI caching,
but has no automatic update action. Generic
PHP has an optional state-declared database and supports OPcache and FastCGI,
but never invokes WP-CLI. Static HTML exposes none of those controls. The API
rejects unsupported state transitions even if a client bypasses the UI.

`sites.map` carries an explicit `$site_php_enabled` capability. Static routes
have no upstream or pool and the nginx PHP location returns 404 before
FastCGI dispatch. Legacy maps default to PHP enabled. The idempotent
`migrate-static-routes.js` upgrade step identifies static roots from panel
state, inspects legacy roots for PHP files, reclassifies those sites as Generic
PHP, includes aliases, refuses mixed static/dynamic roots, removes only
unreferenced pools, validates both services, and restores all files on failure.

## External Integrations

NPM hosts forward managed websites to `hosting-nginx:80` and own public ACME
certificates. When the Cloudflare DNS token is configured, certificate requests
use NPM's Cloudflare DNS-01 provider, so proxied records and Cloudflare security
rules cannot intercept validation. Other domains use HTTP-01 after the NPM client
waits up to two minutes for every requested hostname to resolve. Cloudflare DNS
discovers the longest matching active zone and can perform exact-match bulk
A-record replacement.

Cloudflare Security uses a separate token and only changes rules with a
panel-owned reference. Sensitive-probe and XML-RPC rules are host-scoped. The
login rule is path-only because Cloudflare Free restricts expression fields, so
it protects `/wp-login.php` across the selected zone. Its values are five
requests in 10 seconds and a 10-second block; Free permits one rate rule per zone.

Bulk automation rereads provider state before apply, runs sequentially through
the durable job manager, and stores exact panel-owned rollback state. Temporary
incident rules use a stable website/address reference, exact public addresses,
hostname scope, bounded expiry, and durable removal jobs. Provider settings
shared by multiple selected websites in one zone are changed once.

## Failure Boundaries

- Config mutations restore snapshots after failed validation.
- Backups use partial directories promoted only after completion.
- Integration failures do not expose stored secrets.
- Statistics are sampled on demand; there is no background metrics database.
- IPinfo enrichment is operator-triggered, accepts only an address in the current
  selected-site sample, and stores only bounded normalized fields for 24 hours.
- `hosting-agent` is the only stack service with the Docker socket. A defect in
  its policy or runtime remains host-critical, so keep it private,
  authenticated, minimal, read-only, and covered by command-policy tests.

Primary/standby boundaries, replicated-state rules, fencing, and the manual
promotion sequence are defined in [HIGH_AVAILABILITY.md](HIGH_AVAILABILITY.md).
