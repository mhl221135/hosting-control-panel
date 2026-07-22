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
     -> Docker socket
     -> NPM HTTP API
     -> Cloudflare HTTP API
```

## Service Ownership

| Container | Responsibility | Host ports | Persistent data |
|---|---|---|---|
| `hosting-ui` | Panel, scheduler, provisioning, integrations | `8687` | `app-data/ui-manager` |
| `hosting-npm` | Public reverse proxy and ACME | `80`, `81`, `443` | `app-data/npm` |
| `hosting-nginx` | Internal site routing and FastCGI cache | none | config mounts, `app-data/nginx-cache` |
| `hosting-php-fpm` | PHP 8.4 pools, WP-CLI, image conversion | none | website and config mounts |
| `hosting-db` | MySQL 8.4 for NPM and websites | none | `app-data/mysql` |
| `hosting-redis` | Optional WordPress object cache | none | `app-data/redis` |
| `hosting-files` | File Browser over website roots | none | `app-data/filebrowser` |
| `hosting-phpmyadmin` | Database administration | `8484` | none |

All stack containers use the explicit Docker bridge network `hosting-net`.
Database and Redis ports are intentionally not published.

## Runtime Routing

`sites.map` records one host, document root, upstream, and optional canonical
target per row. `runtime-config.js` parses and renders this file. Internal nginx
uses the host to choose both the root and PHP-FPM upstream. `pools.conf` defines
the matching listener and process limits.

A primary site and its aliases normally share the same document root and
PHP-FPM listener. A canonical redirect from `www` to the primary host is added
when configured. The panel groups rows with the same root and pool so aliases
are not presented as independent websites.

## Panel Process

`server.js` uses Node's built-in HTTP server. It initializes long-lived stores
and managers, serves `/app/public`, authenticates API calls, and dispatches API
routes. There is no Express framework or external npm dependency.

| Module | Owns |
|---|---|
| `auth.js` | scrypt account hash, sessions, throttling, cookies |
| `job-manager.js` | durable queue, conflict scheduling, recovery, cancellation, retries, bounded history |
| `integration-settings.js` | AES-256-GCM secrets and environment fallback |
| `integrations.js` | NPM, ACME, Cloudflare DNS and Security clients |
| `runtime-config.js` | nginx host map and PHP pool parsing/rendering |
| `provisioner.js` | WordPress files, database/user, WP-CLI operations |
| `wordpress-maintenance.js` | allowlisted low-priority WP-CLI cleanup operations |
| `maintenance-manager.js` | persisted manual/weekly maintenance scheduling and progress |
| `site-state.js` | Redis, OPcache, FastCGI, backup and image-schedule switches |
| `backup-manager.js` | schedule, locks, archives, retention, restore |
| `migration-manager.js` | portable export/import and runtime adoption |
| `performance-settings.js` | validated managed configuration directives |
| `dns-presets.js` | reusable Cloudflare record templates |
| `wordpress-packages.js` | uploaded plugin/theme ZIP library |
| `provision-import-store.js` | streamed import staging and archive normalization |
| `stats-collector.js` | on-demand runtime and traffic summaries |
| `image-optimization-manager.js` | persistent sequential WebP job state and daily scheduler |

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
4. for WordPress, creates a database and same-named site user with a random password;
5. installs WordPress and applies clean-install choices, or installs validated HTML/PHP files;
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
Backups, restores, WordPress maintenance, and image optimization use this queue;
their legacy status files remain compatibility views for their existing tabs.

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
a logical database dump, and a manifest. HTML/PHP backups are file-only sets
with an explicit null database. Retention deletes complete sets.

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

Exports are password-free manifests plus website archives and database dumps.
Imports support a full manifest, a lightweight `import-sites.json`, or discovery
from existing `wp-config.php` files. Import generates new database credentials
and rewrites `wp-config.php`; source credentials are never required.

The Provision tab's single-site adapter stages raw uploads below
`imports/ui-provision`, validates archive member paths, rejects symlinks, finds
the sole WordPress document root, and produces the same normalized archive and
manifest consumed by `MigrationManager`. This keeps browser imports on the same
database/runtime rollback path as host-level imports. The final transaction is
a `site.provision` durable job with site/runtime/heavy-work conflicts and safe
cancellation checkpoints before irreversible changes. Core import work runs
under the shared storage-operation lock; external integration failures are
reported as warnings after the site is usable. Generated credentials live only
in an AES-256-GCM encrypted one-time vault, never in persisted job records.

The panel treats Redis management as a WordPress capability. Non-WordPress
website rows omit the Redis state and action, and the API rejects attempts to
enable the WordPress Redis integration for those sites. FastCGI and OPcache
remain available to the current combined HTML/PHP site type because it may
contain executable PHP.

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

## Failure Boundaries

- Config mutations restore snapshots after failed validation.
- Backups use partial directories promoted only after completion.
- Integration failures do not expose stored secrets.
- Statistics are sampled on demand; there is no background metrics database.
- Docker socket compromise of `hosting-ui` is host-level compromise. Restrict
  panel access to administrators and publish it through HTTPS.

Primary/standby boundaries, replicated-state rules, fencing, and the manual
promotion sequence are defined in [HIGH_AVAILABILITY.md](HIGH_AVAILABILITY.md).
