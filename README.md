# Websites V2

Docker-based multi-site WordPress hosting for ARM64 and AMD64 Linux. The stack
keeps the existing shared nginx/PHP architecture while adding an authenticated
control panel for site provisioning, runtime management, Nginx Proxy Manager,
Let's Encrypt, Cloudflare DNS, Redis, and FastCGI cache.

The deployment uses one self-contained root at `/media/ssdmount/websites-v2`.
Source code, persistent service data, website content, and backups are separated
into dedicated directories.

## Features

- Native panel login with scrypt password hashing, login throttling, secure
  cookies, session expiry, and CSRF protection
- Account email and password changes from the panel
- Site and per-site PHP-FPM pool management
- Low, Medium, and High PHP profile selection directly from each website row
- One-click WordPress download, configuration, installation, and admin setup
- Automatic MySQL database and user creation
- Nginx Proxy Manager proxy-host creation and Let's Encrypt certificate actions
- Cloudflare A, AAAA, CNAME, and TXT record management
- Per-site Redis object-cache enablement
- Per-site FastCGI page cache with versioned purge
- Per-site PHP OPcache enablement
- Validated global OPcache, FastCGI, Redis, MySQL, and PHP performance settings
- Deterministic first-install accounts for the panel, NPM, and File Browser
- Global gzip compression and on-demand per-site WebP image generation
- Per-site manual and scheduled backups with retention
- Daily application-data archive and consistent all-databases dump
- Backup history and complete-set deletion from the panel
- Nginx/PHP validation and graceful reload controls
- Runtime logs and service actions
- Encrypted NPM and Cloudflare credentials at rest
- ARM64 PHP image with WP-CLI, GD, Imagick, Intl, Redis, SOAP, Zip, and OPcache

## Architecture

```text
Internet
  |
  v
Nginx Proxy Manager :80/:443
  |
  v
hosting-nginx
  |
  +--> FastCGI page cache (optional per site)
  |
  v
hosting-php-fpm (one pool per site)
  |
  +--> hosting-db
  +--> hosting-redis

Administrator
  |
  v
hosting-ui :8687
  +--> mounted runtime configuration
  +--> Docker socket for controlled provisioning/reloads
  +--> NPM API
  +--> Cloudflare API
```

The panel and website PHP deliberately run in separate containers. The panel
needs control-plane access to Docker, while untrusted website code must not have
that access.

## Project Tree

```text
.
|-- docker-compose.yml
|-- .env.example
|-- bootstrap.sh
|-- README.md
|-- STACK_OVERVIEW.md
|-- scripts/
|   |-- configure.sh
|   |-- install.sh
|   `-- upgrade.sh
|-- filebrowser-custom/
|   |-- Dockerfile
|   `-- entrypoint.sh
|-- global-configs-new-upd/
|   |-- nginx/
|   |   |-- nginx.conf
|   |   `-- conf.d/
|   |       |-- default.conf
|   |       |-- sites.map
|   |       `-- cache.map
|   |-- php/global.ini
|   |-- php-fpm/
|   |   |-- php-fpm.conf
|   |   `-- pools.conf
|   `-- wp/wp-global.php
|-- php-fpm-custom-upd/
|   `-- Dockerfile
`-- ui-manager/
    |-- Dockerfile
    |-- README.md
    |-- app/
    |   |-- server.js
    |   |-- lib/
    |   `-- public/
    `-- data/
        `-- pool-presets.json
```

## Host Storage Layout

```text
/media/ssdmount/websites-v2/
|-- sources/                 # Compose file, Dockerfiles and application source
|-- app-data/                # Persistent service data and runtime configuration
|   |-- configs/
|   |   |-- nginx/
|   |   |-- php/
|   |   |-- php-fpm/
|   |   `-- wp/
|   |-- filebrowser/
|   |-- mysql/
|   |-- nginx-cache/
|   |-- npm/
|   |-- redis/
|   `-- ui-manager/
|-- websites/                # Website document roots
`-- backups/
    |-- app-data/
    `-- example.com/
```

`sources/global-configs-new-upd` contains the versioned configuration templates.
The active, panel-managed copies live in `app-data/configs`.

## Requirements

- ARM64 or AMD64 Linux host
- Docker Engine
- Docker Compose v1.29+ or Docker Compose v2
- DNS records pointing to the host when public websites are enabled
- Optional Cloudflare API token with `Zone:Read` and `DNS:Edit`

## Fresh Installation

Download and run the public bootstrap installer:

```bash
curl -fsSL https://raw.githubusercontent.com/mhl221135/hosting-control-panel/main/bootstrap.sh \
  -o /tmp/websites-v2-bootstrap.sh
sudo sh /tmp/websites-v2-bootstrap.sh
```

It asks for the installation root (default
`/media/ssdmount/websites-v2`) and every initial login and password. It then
clones the project into `<root>/sources`, writes a mode-600 `.env`, creates the
storage layout, copies only missing configuration templates, builds the custom
images, and starts the stack.

The interactive setup requests:

- `UI_ADMIN_EMAIL`
- `UI_ADMIN_PASSWORD`
- `NPM_IDENTITY`
- `NPM_SECRET`
- `ACME_EMAIL`
- `FILEBROWSER_ADMIN_USERNAME`
- `FILEBROWSER_ADMIN_PASSWORD`
- `MYSQL_ROOT_PASSWORD`
- `NPM_DB_USER`
- `NPM_DB_PASSWORD`
- `NPM_DB_NAME`
- optional Cloudflare token and account ID

The installer generates `UI_SETTINGS_KEY` automatically. On an empty data tree,
NPM creates its first administrator from `NPM_IDENTITY` and `NPM_SECRET`. File
Browser creates its first administrator from `FILEBROWSER_ADMIN_USERNAME` and
`FILEBROWSER_ADMIN_PASSWORD`. Existing persistent databases are never
overwritten when `.env` changes.

NPM API, ACME email, and Cloudflare credentials can also be maintained in the
panel's **Settings** tab. Secrets are encrypted with AES-256-GCM in the
persistent panel data directory.

The MySQL root password is never copied into panel settings. The installer
executes database operations inside the MySQL container, where the password is
already available through the container environment.

For an already cloned source tree, run:

```bash
cd /media/ssdmount/websites-v2/sources
sudo ./scripts/install.sh --configure
```

## Upgrade

Upgrade an existing installation without replacing persistent data, websites,
backups, or active configuration:

```bash
cd /media/ssdmount/websites-v2/sources
sudo ./scripts/upgrade.sh
```

The upgrade requires a clean source checkout, pulls `main` with fast-forward
only, refreshes upstream images, rebuilds custom images, validates Compose, and
recreates changed containers. Add `--production` to refresh GoAccess too.

Normal startup excludes GoAccess. Start production-only services with:

```bash
docker-compose --profile production up -d
```

The published port mappings retain the existing stack layout:

| Service | Port |
|---|---:|
| Control panel | 8687 |
| Nginx Proxy Manager HTTP | 80 |
| Nginx Proxy Manager UI | 81 |
| Nginx Proxy Manager HTTPS | 443 |
| GoAccess | 7890 |
| phpMyAdmin | 8484 |

MySQL (`hosting-db:3306`) and Redis (`hosting-redis:6379`) are available only
to containers on `hosting-net`; neither port is published on the host. Redis
does not use a password because it is not published and is isolated to this
Docker network.

Router/firewall exposure is an independent host/network decision. The panel
does not modify router rules.

## First Login

Open `http://SERVER_IP:8687` or publish the panel behind your existing proxy.
Sign in using `UI_ADMIN_EMAIL` and `UI_ADMIN_PASSWORD`.

NPM uses `NPM_IDENTITY` and `NPM_SECRET`. File Browser uses
`FILEBROWSER_ADMIN_USERNAME` and `FILEBROWSER_ADMIN_PASSWORD`. phpMyAdmin uses
the MySQL root or a site database account; it has no separate password database.

The Settings tab contains connection tests for:

- Nginx Proxy Manager
- Cloudflare
- MySQL

## Provision a WordPress Site

1. Open **Provision**.
2. Enter the domain, website directory, title, administrator email, and user.
3. Choose the PHP pool tier.
4. Optionally enable `www`, Redis, OPcache, FastCGI cache, NPM host creation, and SSL.
   Daily backup can also be enabled during provisioning.
5. Submit the form and store the displayed one-time credentials.

Provisioning:

1. Creates the document root and PHP-FPM pool.
2. Adds domain routing to `sites.map`.
3. Validates and reloads nginx/PHP-FPM.
4. Creates a MySQL database and user such as `yogali00_example_com`.
5. Downloads and installs WordPress with WP-CLI.
6. Configures Redis when selected.
7. Creates or reuses the NPM proxy host.
8. Requests and attaches the certificate when selected.

Names longer than MySQL's identifier limit use a deterministic hash suffix.

## Cache Model

OPcache, FastCGI cache, and Redis solve different problems:

- OPcache stores compiled PHP bytecode. Each site can disable it in its own
  PHP-FPM pool; memory and file limits are global.
- FastCGI cache stores complete anonymous HTML responses and is opt-in per site.
- Redis stores WordPress objects and requires the Redis Cache plugin. The panel
  installs and configures that plugin when Redis is enabled for a site.

FastCGI cache bypasses logged-in users, WordPress administration, API and login
paths, query strings, non-GET requests, and common WooCommerce cart/session
cookies. Purging increments a per-site cache version and reloads nginx.

## Compression and Images

Nginx gzip compression is enabled globally for text, CSS, JavaScript, JSON, XML,
SVG, and web fonts. Images are already compressed formats and are not gzipped.

Each website row has an **Optimize images** action. It scans WordPress uploads,
creates quality-82 WebP alternatives for JPEG and PNG files, preserves every
original, skips current outputs, and keeps a WebP only when it is smaller.
Nginx serves the WebP alternative to browsers that advertise WebP support and
falls back to the original file for other clients.

## Security Notes

- `.env`, runtime panel credentials, encryption keys, and NPM persistent data
  are excluded from Git.
- The panel account uses scrypt password hashing.
- NPM and Cloudflare secrets use AES-256-GCM encryption at rest.
- Mutating panel API requests require a valid session and CSRF token.
- Website PHP does not receive Docker socket access.
- Use HTTPS when publishing the panel outside a trusted local network.
- Replace all example credentials before production use.

## Operations

Validate configuration:

```bash
docker exec hosting-nginx nginx -t
docker exec hosting-php-fpm php-fpm -t
```

Inspect status and logs:

```bash
docker-compose ps
docker logs --tail 100 hosting-ui
docker logs --tail 100 hosting-nginx
docker logs --tail 100 hosting-php-fpm
docker logs --tail 100 hosting-db
docker logs --tail 100 hosting-npm
```

GoAccess is production-only:

```bash
docker-compose --profile production up -d hosting-goaccess
docker-compose stop hosting-goaccess
```

## Resource Sizing

The default profile targets a 16 GB Orange Pi 5:

- MySQL InnoDB buffer pool: 4096 MB
- Redis maximum memory: 1024 MB with `allkeys-lru`
- OPcache: 512 MB, 64 MB interned strings, 100000 files, JIT disabled
- FastCGI cache: 128 MB index and 8 GB maximum disk usage
- PHP-FPM pool tiers: 3, 6, and 10 maximum workers

These values are editable in **Settings → Performance**. Do not deploy this
profile unchanged on the current 2 GB OPI3 test host.

## Backups

The panel owns the new backup schedule. In **Backups**, set one daily start time
and the number of complete sets to retain (1-90). A global switch can pause all
manual and scheduled website backups without losing per-site choices. Each
website also has an independent daily-backup switch and a manual **Back up**
action.

A website backup is stored as:

```text
backups/example.com/2026-07-20T03-00-00Z/
|-- website.tar.gz
|-- database.sql.gz
`-- manifest.json
```

Retention operates on the whole timestamped directory, so website files and the
matching database dump cannot be pruned separately. Incomplete work stays in a
hidden `.partial-*` directory and is removed after a failed run.

The **Restore** action is available for every website backup set. Before replacing
the website files and importing its database, the panel creates a new safety
backup. The file swap is staged inside the websites filesystem, and a failed
database import triggers a best-effort rollback to the safety backup. Backup
manifests must match the selected host, document root, and database. Application
data restoration is deliberately a maintenance operation because the affected
containers must be stopped; it is not exposed as an unsafe one-click action.

The daily application-data backup is stored as:

```text
backups/app-data/2026-07-20T03-00-00Z/
|-- app-data.tar.gz
|-- databases.sql.gz
`-- manifest.json
```

The application archive includes configuration, panel state, NPM certificates,
Redis data, and Filebrowser data. It excludes live MySQL files and the
regenerable nginx cache. `databases.sql.gz` is a consistent logical dump of all
MySQL databases.

The scheduler uses the container timezone (`Europe/Kyiv`) and runs enabled
website backups sequentially, followed by application data. Only one manual or
scheduled backup can run at a time.

Image optimization uses the same operation lock as backups, so archive
compression and ImageMagick cannot saturate storage and CPU at the same time.
Backup archives run with reduced CPU and I/O priority and omit transient WebP
optimizer files.

## Cloudflare DNS

The **DNS & SSL** tab lists all Cloudflare records at the selected website host
and below it, and supports creating, editing, and deleting A, AAAA, CNAME, TXT,
MX, and CAA records.

Reusable DNS presets are managed in **Settings** and can be applied to any
selected website. Use `@` for the selected host, a relative name such as `www`,
or `{domain}` in name and content templates.

Both user-owned (`cfut_`) and account-owned (`cfat_`) Cloudflare API tokens are
supported. Account-owned tokens also require the 32-character Cloudflare
Account ID in Settings.

Settings also stores a reusable list of server IPv4 addresses. The bulk
replacement tool changes only A records whose content exactly matches the
selected old IP, across every active zone available to the configured
Cloudflare token. It preserves proxy and TTL settings, requires confirmation,
and reports each changed hostname.

The legacy host-specific `backup_websites.sh` remains excluded from Git and is
not invoked or modified by this panel.

## Additional Documentation

- [STACK_OVERVIEW.md](STACK_OVERVIEW.md): runtime ownership and provisioning flow
- [ui-manager/README.md](ui-manager/README.md): panel-specific configuration
