# Websites Control Panel

The panel is built into the main Compose project and runs as
`hosting-ui` on port 8687.

## First login

Initial credentials come from `UI_ADMIN_EMAIL` and `UI_ADMIN_PASSWORD` in the
project `.env`. The default credentials force an account update after login.
The stored password is scrypt-hashed in the persistent
`app-data/ui-manager/admin-account.json` file.

## Settings

Open **Settings** in the panel to configure:

- Nginx Proxy Manager API URL, login identity, and password
- Cloudflare API token
- Separate Cloudflare Security API token
- MySQL container name and database/user prefix
- Global PHP, OPcache, FastCGI, Redis, and MySQL resource limits
- Telegram and external SMTP job notifications, recipients, severity filters, and test actions
- Scheduled operational health checks, incident/recovery notifications, thresholds, and required containers

NPM and Cloudflare secrets are encrypted at rest with AES-256-GCM. Use
`UI_SETTINGS_KEY` for a stable externally managed encryption key, or let the
panel create a restricted local key in its data directory.

Telegram bot tokens and SMTP passwords use the same encryption design in a
separate notification settings file. Failed, partial, and cancelled jobs notify
enabled channels by default; successful-job alerts are opt-in. Delivery retry
state is durable and visible in **Jobs**.

The **Health** workspace checks core containers, MySQL, the NPM API and attached
certificate expiry, OPcache pressure, and website/backup storage. It records
only incident transitions, sends recovery alerts, and keeps bounded state in
`/app/data/health-state.json`. Configure it in **Settings**; scheduled checks are
disabled by default.

The MySQL root password stays in the MySQL container environment and is never
stored by the panel.

## Cloudflare security

The **Security** tab applies narrowly scoped WAF and rate-limit presets to one
hosted website at a time. It uses a separate `CLOUDFLARE_SECURITY_API_TOKEN`
credential and never edits rules that were not created by Hosting Control.

The sensitive-probe and XML-RPC rules are hostname-scoped. The login rate limit
is Cloudflare Free-compatible at five requests in 10 seconds with a 10-second
block. Because the Free rate-limit field set does not include hostname, that
preset protects `/wp-login.php` across the selected Cloudflare zone. Free allows
one rate-limit rule per zone.

## Statistics

The **Stats** tab collects runtime data only when opened or manually refreshed.
Server, container, PHP-FPM pool, Redis, and FastCGI snapshots are cached for 30
seconds. Website disk usage and the selected NPM access-log sample are cached
for five minutes. No background metrics database or permanent polling service
is required.

## Background jobs

Backups, restores, maintenance, and image optimization run through a durable
queue stored in `/app/data/jobs.json`. The **Jobs** workspace shows queued and
running work, progress, conflict blockers, bounded failures, history, retries,
and cancellation at safe operation boundaries. Queued jobs survive a panel
restart; interrupted running jobs are marked failed. `JOB_HISTORY_LIMIT`
controls retained records and defaults to 250.

## Website provisioning

Open **Provision** to create a site, PHP-FPM pool, database and database user,
install WordPress, enable optional Redis/OPcache/FastCGI cache, and create the NPM
proxy host and certificate. Provisioning can create/update Cloudflare host DNS,
apply a named multi-record DNS preset, and install selected ZIP packages from the
persistent plugin/theme library. Generated credentials are shown once.

The same form provisions database-free **Static / PHP** sites. Fresh mode creates
a minimal index, while import mode accepts only the validated website archive,
flattens one wrapper directory, and keeps PHP execution isolated in the site's
pool. Static/PHP backups and restores are file-only sets.

Fresh installations remove the Hello World post and close comments by default.
Bundled WordPress plugins and inactive bundled themes are removed unless their
retention controls are selected. If no custom theme is selected, the active
bundled theme remains so the new website has a functioning frontend.

Provision also has an **Import website** source mode. It sends ZIP/TAR website
archives in resumable 16 MB chunks, safely excludes symbolic links, and accepts
SQL/SQL.GZ dumps or a TAR.GZ/TGZ containing exactly one dump. It accepts a nested
`public_html`-style document root, generates new database credentials, updates
`wp-config.php`, migrates the WordPress URL, and preserves imported accounts and
content. Chunk offsets are carried in validated URL parameters so restrictive
edge proxies do not reject browser-controlled range headers. Failed chunks
retry without restarting the archive. Extracted WordPress ownership and modes
are normalized before WP-CLI reads `wp-config.php`. Staging expires
after 24 hours and is removed immediately after a successful import.

## Sites and image optimization

Hosts that share the same document root and PHP-FPM pool are presented as one
website with aliases, even when an imported configuration has no canonical
redirect marker. Per-site and bulk image optimization preserve source images and
create smaller WebP alternatives. The bulk job runs one primary website at a
time, persists progress in `/app/data`, and does not overlap backup operations.
Automatic optimization is disabled by default. Settings holds the global daily
schedule, and each primary website has an independent **Images daily** checkbox.
Scheduled runs skip current WebP files and share the backup operation lock.
Nginx performs delivery without changing website content: the original JPG or
PNG URL serves its WebP sidecar to compatible browsers. These negotiated URLs
bypass shared caches to prevent Cloudflare from mixing response formats.

## Website deletion

The **Delete** tab previews resource ownership and provides separate controls
for routes, aliases, pool, files, database/user, NPM host and certificate,
Cloudflare web DNS, panel state, and backups. It requires typed domain
confirmation, recalculates safety on submit, blocks shared resources, and uses
the backup operation lock. A final backup is selected by default and existing
backups are retained unless explicitly selected for deletion.

## Portable website migration

The host-level `scripts/export-websites.sh` and `scripts/import-websites.sh`
commands run `/app/cli/sites-transfer.js` inside this container. The CLI can
export configured sites with a JSON manifest, read a lightweight
`import-sites.json`, or adopt manually copied WordPress folders and timestamped
`.sql.gz` dumps. It reuses the panel's encrypted Cloudflare/NPM settings and
never writes those secrets to an export.

## Persistent and mounted paths

- `/app/data`: panel account, encrypted settings, durable jobs, site state,
  config backups, DNS presets, and uploaded WordPress package ZIPs
- `/srv/websites`: website files
- `/srv/exports`: portable export output
- `/srv/imports`: staged import input
- `/srv/configs/nginx`: internal nginx configuration
- `/srv/configs/php-fpm`: PHP-FPM pool configuration
- `/var/run/docker.sock`: controlled provisioning and service reload operations

## Deploy

The public `bootstrap.sh` performs an interactive fresh installation. From an
already cloned `/media/ssdmount/websites-v2/sources` tree:

```bash
sudo ./scripts/install.sh --configure
```

The installer asks for every required account and password and writes `.env`.
First-run NPM and File Browser accounts are initialized without replacing
accounts in existing persistent databases. Use `sudo ./scripts/upgrade.sh` for
non-destructive source and container upgrades.

See the repository-level `AGENTS.md` and `docs/` directory for architecture,
API, persistent-state, testing, deployment, and rollback details.
