# Stack Overview

Deployment source: `/media/ssdmount/websites-v2/sources`

Persistent data: `/media/ssdmount/websites-v2/app-data`

Website files: `/media/ssdmount/websites-v2/websites`

Managed backups: `/media/ssdmount/websites-v2/backups`

## Request path

1. Nginx Proxy Manager accepts public HTTP/HTTPS traffic.
2. It forwards website traffic to `global-nginx-internal:80`.
3. Internal nginx selects the document root and PHP-FPM pool from `sites.map`.
4. PHP runs in the site's dedicated pool in `global-php-fpm`.
5. WordPress uses `mysql-db` and may use `redis-mysweetdesign`.

The control panel remains a separate container from PHP. It has Docker socket
access for provisioning and reload operations, while website PHP does not.

## Services

- `websites-config-ui`: authenticated control panel on port 8687
- `global-nginx-internal`: internal virtual hosts and optional FastCGI cache
- `global-php-fpm`: shared PHP 8.4 runtime with per-site pools and WP-CLI
- `nginx-proxy-manager`: public proxy hosts and Let's Encrypt certificates
- `mysql-db`: MySQL 8.4
- `redis-mysweetdesign`: Redis 7
- `phpmyadmin`, `filebrowser-web`, and `goaccess`: existing administration tools

## Control panel

The panel provides:

- Native email/password login, throttling, secure cookies, and CSRF protection
- Account email and password changes
- Site and PHP-FPM pool management
- One-click WordPress provisioning
- Per-site Redis object cache and FastCGI page-cache controls
- Global gzip and on-demand WebP generation with original-image fallback
- FastCGI cache purge
- Nginx Proxy Manager host, SSL, and renewal controls
- Cloudflare DNS record management
- Encrypted integration settings for NPM and Cloudflare
- MySQL installer container and database-prefix settings
- Per-site manual and scheduled backup controls
- Global website-backup pause, schedule, retention, app-data protection, and history
- Runtime reload, OPcache clear, and log views

The MySQL root password is not copied into panel settings. Database operations
read it from the MySQL container environment and execute inside that container.

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
- `app-data/ui-manager/auth.json`: hashed panel account
- `app-data/ui-manager/integrations.json`: encrypted integration settings
- `app-data/ui-manager/site-state.json`: Redis, cache, and backup state
- `app-data/ui-manager/backup-settings.json`: schedule and retention

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

## Caching

OPcache and FastCGI cache are separate:

- OPcache stores compiled PHP bytecode and is enabled globally.
- FastCGI cache stores complete anonymous HTML responses and is opt-in per site.

FastCGI cache bypasses logged-in users, WordPress administration, requests with
query strings, non-GET requests, and common WooCommerce session/cart traffic.

## Backup flow

1. The panel scheduler checks the configured local start time every 30 seconds.
2. Enabled websites are processed sequentially.
3. WordPress supplies the site's database name through WP-CLI.
4. Website files are archived and MySQL creates a consistent compressed dump.
5. A manifest is written and the partial directory is atomically promoted.
6. Complete backup sets beyond the configured retention are removed.
7. Application data is archived, excluding live MySQL files and nginx cache,
   and paired with a consistent dump of every MySQL database.

The existing `backup_websites.sh` is unchanged and is not part of this flow.
