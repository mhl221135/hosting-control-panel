# Stack Overview

Deployment source: `/media/ssdmount/websites-v2/sources`

Persistent data: `/media/ssdmount/websites-v2/app-data`

Website files: `/media/ssdmount/websites-v2/websites`

Managed backups: `/media/ssdmount/websites-v2/backups`

Portable exports: `/media/ssdmount/websites-v2/exports`

Staged imports: `/media/ssdmount/websites-v2/imports`

## Request path

1. Nginx Proxy Manager accepts public HTTP/HTTPS traffic.
2. It forwards website traffic to `hosting-nginx:80`.
3. Internal nginx selects the document root and PHP-FPM pool from `sites.map`.
4. PHP runs in the site's dedicated pool in `hosting-php-fpm`.
5. WordPress uses `hosting-db` and may use `hosting-redis`.

The control panel remains separate from PHP, runs as UID/GID `33:33` with all
Linux capabilities dropped, and has no Docker socket. Its broad app-data view
is read-only. It calls the authenticated, private `hosting-agent`, whose
server-side policy permits only the runtime inspection, reload, WP-CLI, and
database operations required by supported workflows.

Machine-local `standalone`, `primary`, and `standby` roles are supported. A
standby starts only the agent and read-only panel, rejects normal mutations
with HTTP 423, and suppresses mutating schedulers. Its sole mutating panel
exception is the allowlisted deep backup-verification job; ingress metadata can
also be saved without changing traffic or role.

Backup reception, deep verification, fenced restore preparation, and guarded
local promotion are separate stages. Local promotion requires the exact
prepared recovery ID plus typed old-primary fencing confirmation, validates the
runtime before changing the machine marker, and records that public ingress has
not been cut over. Cloudflare/DNS/tunnel switching remains a separate pending
control-plane workflow.

## Services

- `hosting-ui`: authenticated control panel on port 8687
- `hosting-agent`: private allowlisted Docker control boundary with no host port
- `hosting-billing`: isolated renewal inventory and signed entitlement API on port 8787
- `hosting-nginx`: internal virtual hosts and optional FastCGI cache
- `hosting-php-fpm`: shared PHP 8.4 runtime with per-site pools and WP-CLI
- `hosting-npm`: public proxy hosts and Let's Encrypt certificates
- `hosting-db`: MySQL 8.4
- `hosting-redis`: Redis 7
- `hosting-phpmyadmin` and `hosting-files`: administration tools

## Control panel

The panel provides:

- Native email/password login, throttling, secure cookies, and CSRF protection
- Account email and password changes
- Site and PHP-FPM pool management
- One-click WordPress provisioning
- Per-site Redis object cache, OPcache, and FastCGI page-cache controls
- Global PHP, OPcache, FastCGI, Redis, and MySQL performance settings
- Global gzip and on-demand WebP generation with original-image fallback
- Read-only WordPress inventory and manual backup-protected updates with
  persistent exclusions, health validation, and automatic rollback
- WordPress, required-database OpenCart, optional-database Generic PHP, and Static HTML adapter types
- FastCGI cache purge
- Nginx Proxy Manager host, SSL, and renewal controls
- Cloudflare DNS record management
- Dry-run Cloudflare bulk hardening, rollback, provisioning defaults, and
  expiring hostname-scoped traffic mitigations
- Encrypted integration settings for NPM and Cloudflare
- Encrypted Telegram and external SMTP job notifications with retries, severity filters, and confirmed allowlisted Telegram operations
- Transition-based operational health checks and recovery alerts for containers,
  MySQL, NPM certificates, selected public websites, OPcache, and storage
- MySQL installer container and database-prefix settings
- Per-site manual and scheduled backup controls
- Global website-backup pause, schedule, retention, app-data protection, and history
- Optional encrypted Restic replication to independent S3-compatible storage
- Independent billing CSV inventory, renewal states, encrypted WooCommerce
  payment links/webhooks, durable Telegram/SMTP reminders, audit, and verified
  SQLite restore points
- Remote WordPress enrollment (hashed enrollment codes, Ed25519-signed
  entitlement delivery, encrypted signing-key storage, throttled heartbeats)
- Fail-open remote WordPress consumer package with encrypted credentials,
  signature checks, cron/manual polling, and Site Health status
- Durable ownership-aware website deletion with safe cancellation boundaries
- Runtime reload, OPcache clear, and log views
- Cross-process serialized, rollback-safe runtime transactions for every PHP-FPM pool
  mutation: atomic map/pool writes, nginx/PHP validation, controlled reloads,
  verified port activation with bounded retries, gap-aware port allocation, and
  distinct rollback outcomes
- Shared guarded request validation and a bounded runtime-configuration
  mutation audit with a read-only Runtime history view
- Bounded, atomic, guarded non-runtime settings persistence (performance,
  backup/off-site, notifications, integrations, health, billing, Cloudflare,
  IP, DNS presets) with encrypted secret preservation and fail-closed rolls
- Guarded, capability-safe site-state switches, cache purge, image-optimization
  schedules, maintenance settings, and WordPress update pins, with a single-lock
  atomic site-state transaction that restores all runtime files on failure
- CPU-aware PHP-FPM capacity planning: per-profile worker-memory estimates,
  worker slots, slots per CPU, estimated/RAM-ceiling summaries, and
  healthy/warning/critical guardrails, with a conservative fallback for
  custom/drifted pools
- Manual-refresh server/container statistics, per-pool PHP usage, cache health,
  and selected-site NPM traffic summaries

The MySQL root password is not copied into panel settings. Database operations
read it from the MySQL container environment and execute inside that container.
Redis is not published on the host and has no password; only services attached
to `hosting-net` can reach it.

## Installation and upgrades

`bootstrap.sh` asks for the storage root and credentials, clones the public
repository into `<root>/sources`, and runs the fresh installer.
`scripts/upgrade.sh` fast-forwards the source and recreates updated containers
without replacing `app-data`, `websites`, `backups`, or active copied configs.

## Configuration

Versioned configuration templates are stored in:

- `global-configs-new-upd/nginx`
- `global-configs-new-upd/php`
- `global-configs-new-upd/php-fpm`
- `global-configs-new-upd/wp`

Active runtime configuration is mounted from `app-data/configs`. Important
generated and persistent files include:

- `app-data/configs/nginx/conf.d/sites.map`: domain routing
- `app-data/configs/nginx/conf.d/cache.map`: per-site FastCGI state
- `app-data/configs/php-fpm/pools.conf`: per-site PHP-FPM pools
- `app-data/ui-manager/admin-account.json`: hashed panel account
- `app-data/ui-manager/integration-settings.json`: encrypted integration settings
- `app-data/ui-manager/integration-settings.key`: generated encryption key when
  `UI_SETTINGS_KEY` is not supplied
- `app-data/ui-manager/notification-settings.json`: encrypted Telegram/SMTP configuration
- `app-data/ui-manager/notification-settings.key`: generated notification encryption key
- `app-data/ui-manager/notification-deliveries.json`: bounded durable delivery history
- `app-data/ui-manager/health-settings.json`: health schedule, thresholds, and required containers
- `app-data/ui-manager/health-state.json`: active incidents and bounded transition history
- `app-data/ui-manager/jobs.json`: durable background-job history and latest alert status
- `app-data/ui-manager/site-state.json`: Redis, OPcache, cache, and backup state
- `app-data/ui-manager/performance-settings.json`: validated global resource limits
- `app-data/ui-manager/php-fpm-audit.json`: bounded atomic audit history for PHP-FPM profile save, preview, and apply operations
- `app-data/ui-manager/runtime-config-audit.json`: bounded atomic audit history for pool, host, provisioning, import, opcache, and removal runtime mutations
- `app-data/ui-manager/backup-settings.json`: schedule and retention
- `app-data/ui-manager/offsite-backup-settings.json`: encrypted off-site settings and schedule state
- `app-data/billing`: separate billing database and administrator account
- `${BACKUPS_DIR}/billing`: checksummed billing database snapshots

## Provisioning

WordPress provisioning performs these steps:

1. Validate the domain and target directory.
2. Add the internal nginx host and PHP-FPM pool.
3. Create a MySQL database and user with the configured prefix.
4. Download and configure WordPress through WP-CLI.
5. Install WordPress and optionally enable Redis.
6. Create or reuse an NPM proxy host.
7. Request and attach a Let's Encrypt certificate.
8. Reload nginx and PHP-FPM after configuration validation.

Database identifiers use the form `yogali00_example_com`. Names exceeding the
MySQL identifier limit are shortened with a deterministic hash suffix.

Generic PHP can create the same isolated database/user pair and optionally
import a dump, but never runs WP-CLI or rewrites application configuration.
The generated credentials are exposed through the encrypted one-time vault.
OpenCart is import-only and requires an archive plus database dump. The panel
detects storefront and renamed admin configurations, rewrites database, URL,
and absolute path constants, validates both PHP entry points, and applies
commerce-safe cache bypass rules. Backups, restores, exports, imports, and
resource deletion use the same adapter-aware managers.
Static HTML has no managed database or PHP cache actions.
Its route explicitly disables PHP execution and does not allocate a PHP-FPM
pool. The upgrade migration converts legacy Static HTML routes and removes only
their now-unreferenced pools after nginx and PHP-FPM validation.

## Caching

OPcache, FastCGI cache, and Redis are separate:

- OPcache stores compiled PHP bytecode and can be disabled in each site's pool.
- FastCGI cache stores complete anonymous HTML responses and is opt-in per site.
- Redis stores WordPress objects and is enabled with the Redis Cache plugin.

FastCGI cache bypasses logged-in users, WordPress administration, requests with
query strings, non-GET requests, and common WooCommerce session/cart traffic.

## Backup flow

1. The panel scheduler checks the configured local start time every 30 seconds.
2. Enabled websites are processed sequentially.
3. WordPress supplies the site's database name through WP-CLI.
4. Website files are archived while their SHA-256 is streamed, and MySQL
   creates a consistent compressed dump.
5. A manifest is written and the partial directory is atomically promoted.
6. Complete backup sets beyond the configured retention are removed.
7. Application data is archived, excluding live MySQL files and nginx cache,
   and paired with a consistent dump of every MySQL database.

The existing `backup_websites.sh` is unchanged and is not part of this flow.

## Migration flow

`scripts/export-websites.sh` runs the migration CLI inside `hosting-ui`, groups
hosts by document root and PHP pool, archives each website, dumps its WordPress
database, and writes a password-free JSON manifest with SHA-256 checksums. The
Transfers workspace uses the same manager through durable `sites.export` and
`sites.import` jobs, shares the backup storage lock, and preserves independent
per-site results. Import preview accepts only real staged directories below
`imports`, fingerprints the source, exposes blocking file/database/runtime
conflicts and exact-host DNS/NPM matches, and requires typed confirmation. The
import job revalidates the fingerprint and conflicts before mutation and is
deliberately non-cancellable and non-retryable.
Exact-source staging cleanup is a separate durable job sharing the
`storage:imports` conflict. It removes only a direct manifest-bearing import
directory and cannot reach the website or database mounts.
Exports also create a complete TAR.GZ bundle. Browser bundle uploads use the
existing ordered chunk protocol, can resume from the committed server offset,
and queue `sites.import-upload-stage` for archive, symlink, manifest, checksum
coverage, and checksum validation. Failed upload workspaces expire after 24
hours; successful validation moves only the normalized source into `imports`.

`scripts/import-websites.sh` stages an export or dump directory below
`imports`. Manifest imports restore archives. Manual imports discover copied
WordPress directories from `wp-config.php` and match the newest timestamped
dump by `DB_NAME`. Import creates database credentials, runtime routes and
pools, Cloudflare A records, the NPM host, and SSL.
