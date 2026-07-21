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
- Automatic grouping of `www` and other aliases under their primary website
- Low, Medium, and High PHP profile selection directly from each website row
- One-click WordPress download, configuration, installation, and admin setup
- Provision-time website imports from ZIP/TAR archives and SQL/SQL.GZ dumps
- Automatic MySQL database and user creation
- Nginx Proxy Manager proxy-host creation and Let's Encrypt certificate actions
- Cloudflare A, AAAA, CNAME, and TXT record management
- Cloudflare sensitive-path, XML-RPC, and login rate-limit security presets
- Per-site Redis object-cache enablement
- Per-site FastCGI page cache with versioned purge
- Per-site PHP OPcache enablement
- Validated global OPcache, FastCGI, Redis, MySQL, and PHP performance settings
- Deterministic first-install accounts for the panel, NPM, and File Browser
- Global gzip compression and per-site or bulk WebP image generation
- Per-site manual and scheduled backups with retention
- Daily application-data archive and consistent all-databases dump
- Backup history and complete-set deletion from the panel
- Ownership-aware website removal with selectable routes, pool, files, database,
  NPM, certificate, Cloudflare DNS, panel state, and backups
- Nginx/PHP validation and graceful reload controls
- Runtime logs and service actions
- On-demand server, container, PHP-pool, Redis, FastCGI, website disk, and recent traffic statistics
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
|-- AGENTS.md
|-- docs/
|   |-- API.md
|   |-- ARCHITECTURE.md
|   |-- CONFIGURATION.md
|   |-- OPERATIONS.md
|   |-- SECURITY.md
|   `-- UI_GUIDE.md
|-- scripts/
|   |-- configure.sh
|   |-- export-websites.sh
|   |-- import-websites.sh
|   |-- install.sh
|   |-- migrate-webp-cache.sh
|   `-- upgrade.sh
|-- filebrowser-custom/
|   |-- Dockerfile
|   `-- entrypoint.sh
|-- npm-custom/
|   `-- Dockerfile
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
|-- examples/
|   `-- import-sites.sample.json
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
|-- imports/                 # Staged migration input
`-- backups/                 # Default; BACKUPS_DIR may place this on another disk
    |-- app-data/
    |-- exports/             # Default EXPORTS_DIR for portable migrations
    `-- example.com/
```

`sources/global-configs-new-upd` contains the versioned configuration templates.
The active, panel-managed copies live in `app-data/configs`.

## Requirements

- ARM64 or AMD64 Linux host
- Docker Engine
- Docker Compose v1.29+ or Docker Compose v2
- DNS records pointing to the host when public websites are enabled
- Optional Cloudflare DNS token with `Zone:Read` and `DNS:Edit`
- Optional separate Cloudflare Security token with zone read and Rulesets/WAF
  write permissions available for the token type and account

## Fresh Installation

Download and run the public bootstrap installer:

```bash
curl -fsSL https://raw.githubusercontent.com/mhl221135/hosting-control-panel/main/bootstrap.sh \
  -o /tmp/websites-v2-bootstrap.sh
sudo sh /tmp/websites-v2-bootstrap.sh
```

It asks for the installation root (default
`/media/ssdmount/websites-v2`), independent absolute backup and website-export
directories, and every initial login and password. The export directory defaults
to `<BACKUPS_DIR>/exports`. It then
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
- optional Cloudflare DNS token, Security token, and account ID

The installer generates `UI_SETTINGS_KEY` automatically. On an empty data tree,
NPM creates its first administrator from `NPM_IDENTITY` and `NPM_SECRET`. File
Browser creates its first administrator from `FILEBROWSER_ADMIN_USERNAME` and
`FILEBROWSER_ADMIN_PASSWORD`. Existing persistent databases are never
overwritten when `.env` changes.

NPM API, ACME email, and both Cloudflare credentials can also be maintained in the
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
recreates changed containers.
Nginx Proxy Manager is pinned to the tested `2.15.0` release; the upgrade script
pulls that image as a required step instead of silently retaining an older local image.

The published port mappings retain the existing stack layout:

| Service | Port |
|---|---:|
| Control panel | 8687 |
| Nginx Proxy Manager HTTP | 80 |
| Nginx Proxy Manager UI | 81 |
| Nginx Proxy Manager HTTPS | 443 |
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
4. Choose whether to create/update Cloudflare host DNS and optionally apply a
   named multi-record DNS preset.
5. Select uploaded plugin/theme ZIP packages and optional cache, NPM, SSL, and
   daily backup settings.
6. Choose whether to keep bundled WordPress plugins/themes or enable comments.
   These options are off by default, and the initial Hello World post is removed.
7. Submit the form and store the displayed one-time credentials.

To move an existing WordPress site, select **Import website** under Website
source. Upload a ZIP, TAR, TAR.GZ, or TGZ containing exactly one
`wp-config.php`, plus an SQL or SQL.GZ database dump. The importer accepts files
at the archive root or below a wrapper such as `public_html`, creates a new
database/user/password, rewrites `wp-config.php`, performs a serialized-safe URL
replacement, and preserves imported WordPress users, content, plugins, and
themes. It then applies the selected pool, cache, backup, DNS, NPM, and SSL
options.

Uploads use resumable 16 MB chunks staged under `imports/ui-provision` instead
of being held in UI memory. Website archives are limited to 8 GB, database dumps
to 4 GB, and abandoned staging directories expire after 24 hours. Database input
can be SQL/SQL.GZ or a TAR.GZ/TGZ containing exactly one dump. Archive paths are
checked before extraction and website symlinks are safely excluded. The import
itself shares the storage lock with backups, image optimization, and deletion.

When the panel is behind NPM, its proxy host needs these Advanced directives for
large streamed uploads:

```nginx
client_max_body_size 8g;
client_body_timeout 1h;
proxy_request_buffering off;
proxy_connect_timeout 60s;
proxy_send_timeout 1h;
proxy_read_timeout 4h;
send_timeout 1h;
```

After creating the panel's NPM host, apply those directives without changing
other proxy hosts:

```bash
docker exec hosting-ui node /app/cli/configure-panel-upload.js ui.example.com
```

Provisioning:

1. Creates the document root and PHP-FPM pool.
2. Adds domain routing to `sites.map`.
3. Validates and reloads nginx/PHP-FPM.
4. Creates a MySQL database and user such as `yogali00_example_com`.
5. Downloads and installs WordPress with WP-CLI.
6. Applies clean-install content settings and selected plugin/theme packages.
7. Creates or updates Cloudflare DNS and preset records when selected.
8. Configures Redis when selected.
9. Creates or reuses the NPM proxy host.
10. Waits for every certificate hostname to resolve publicly, then requests and
    attaches the certificate when selected. Fresh DNS is checked every five
    seconds for up to two minutes to avoid immediate ACME `NXDOMAIN` failures.

Uploaded WordPress packages are stored persistently under
`app-data/ui-manager/wordpress-packages`. Uploads are limited to ZIP files and
128 MB each. Selected plugins are activated; selected themes are installed and
the first available selected theme is activated.

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

## Website Removal

The dedicated **Delete** tab builds a fresh ownership preview before allowing a
destructive action. Select the primary website, choose individual resources,
and type the domain exactly. By default it creates a final safety backup and
retains older backup sets.

The preview covers internal host routes and aliases, the PHP-FPM pool, website
files, WordPress database and user, NPM proxy host and certificate, exact
Cloudflare A/AAAA/CNAME records, panel state, and stored backups. Shared pools,
document roots, databases, NPM hosts, and certificates are disabled rather than
deleted. Database ownership is checked against every configured primary site's
`wp-config.php` before deletion.

All selected work runs under the same storage-operation lock as backups and
image optimization. The backend rebuilds the preview after confirmation, so a
stale browser cannot bypass ownership checks. Existing backups are deleted only
when their separate checkbox is selected; a final backup and backup deletion
cannot be selected together.

## Compression and Images

Nginx gzip compression is enabled globally for text, CSS, JavaScript, JSON, XML,
SVG, and web fonts. Images are already compressed formats and are not gzipped.

Each website row has an **Optimize images** action. It scans WordPress uploads,
creates quality-82 WebP alternatives for JPEG and PNG files, preserves every
original, skips current outputs, and keeps a WebP only when it is smaller.
Nginx serves the WebP alternative to browsers that advertise WebP support and
falls back to the original file for other clients. Negotiated JPEG and PNG
responses are private-cache responses so Cloudflare cannot reuse one browser's
format for another browser. Explicit WebP URLs remain edge-cacheable.

The **Optimize all images** action processes primary websites sequentially in a
persisted background job. Progress remains visible in the Sites header, aliases
are not processed twice, and the job shares the backup lock so image conversion
cannot overlap a backup or restore.

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

## Resource Sizing

The default profile targets a 16 GB Orange Pi 5:

- MySQL InnoDB buffer pool: 2048 MB, leaving memory for other host workloads
- Redis maximum memory: 1024 MB with `allkeys-lru`
- OPcache: 512 MB, 64 MB interned strings, 100000 files, JIT disabled
- FastCGI cache: 128 MB index and 8 GB maximum disk usage
- PHP-FPM pool tiers: 3, 6, and 10 maximum workers

These values are editable in **Settings → Performance**. Do not deploy this
profile unchanged on the current 2 GB OPI3 test host.

## Backups

The host backup location is configured by `BACKUPS_DIR` in `.env`. It defaults
to `<HOSTING_ROOT>/backups` but may point to another mounted disk, such as
`/media/seagate/websites-backups-v2`. Inside the panel it is always mounted as
`/srv/backups`.

The panel owns the new backup schedule. In **Backups**, set one daily start time
and the number of complete sets to retain (1-90). A global switch can pause all
manual and scheduled website backups without losing per-site choices. Each
website also has an independent daily-backup switch and a manual **Back up**
action. The Backups tab can immediately back up all daily-enabled websites or
override the per-site switches and back up every configured primary website.
Both batch actions respect the global website-backup pause.

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

## Website Migration

Create a portable export from the running stack:

```bash
cd /media/ssdmount/websites-v2/sources
sudo ./scripts/export-websites.sh
```

The host output directory is configured by `EXPORTS_DIR` in `.env` and is
mounted as `/srv/exports` in the panel container. Fresh installations default it
to `<BACKUPS_DIR>/exports`.

The script can export every configured primary site or a comma-separated
selection. It writes a directory such as:

```text
exports/export-2026-07-19_02-00/
|-- manifest.json
|-- sites/
|   `-- example_com.tar.gz
`-- databases/
    `-- yogali00_example_com_2026-07-19_02-00.sql.gz
```

`manifest.json` contains no passwords. For each site it records the primary
domain, aliases, canonical redirects, website path, original database name,
archive and dump paths, PHP profile, and cache/backup state.

Import an export or adopt website directories that were copied manually:

```bash
sudo ./scripts/import-websites.sh
```

The host script asks for a source directory and stages it under `imports`. If
the source contains `manifest.json`, website archives and matching database
dumps are imported from that manifest. Without a manifest, the importer scans
`websites` for unconfigured `wp-config.php` files, reads each `DB_NAME`, asks
for its domain and aliases, and selects the newest matching dump using names
such as `yogali00_b389_2026-07-19_02-00.sql.gz`.

For a JSON-driven site list, put `import-sites.json` beside the database dumps.
A sample is available at `examples/import-sites.sample.json`. Each entry only
requires a website path relative to the `websites` directory and its domain:

```json
{
  "version": 1,
  "type": "hosting-sites-import",
  "sites": [
    {
      "websitePath": "example.com",
      "domain": "example.com",
      "aliases": ["www.example.com"],
      "poolTier": "medium"
    }
  ]
}
```

The website files must already exist at `websites/<websitePath>`. The importer
reads `DB_NAME` from that site's `wp-config.php` and selects the newest matching
`.sql.gz` file from the chosen dump directory. The JSON therefore needs no
database names, passwords, or dump paths.

For each imported site the migration process:

1. Refuses to overwrite a non-empty destination or an existing database.
2. Creates a database and MySQL user with the database name.
3. Generates a new random database password and writes it to `wp-config.php`.
4. Imports the compressed SQL dump and normalizes WordPress permissions.
5. Creates the PHP-FPM pool, internal nginx routes, aliases, and cache state.
6. Creates or replaces Cloudflare host records with valid IPv4 A records.
7. Creates the NPM proxy host, requests SSL, and updates the WordPress URL.

A DNS CNAME cannot target an IP address. The importer therefore uses A records
for both apex domains and subdomains. Cloudflare and NPM credentials are read
from encrypted panel settings or `.env`; they are never embedded in migration
scripts or manifests. DNS, NPM, and SSL failures are reported as warnings so
imported files and databases remain available for correction.

## Cloudflare DNS

The **DNS & SSL** tab lists all Cloudflare records at the selected website host
and below it, and supports creating, editing, and deleting A, AAAA, CNAME, TXT,
MX, and CAA records.

Reusable DNS preset sets are managed in **Settings**. Each named preset can
contain up to 50 records and can be applied from **DNS & SSL** or during a new
WordPress installation. Use `@` for the selected host, a relative name such as
`www`, or `{domain}` in name and content templates. Existing single-record
presets are migrated automatically when read.

Both user-owned (`cfut_`) and account-owned (`cfat_`) Cloudflare API tokens are
supported. Account-owned tokens also require the 32-character Cloudflare
Account ID in Settings.

Settings also stores a reusable list of server IPv4 addresses. The bulk
replacement tool changes only A records whose content exactly matches the
selected old IP, across every active zone available to the configured
Cloudflare token. It preserves proxy and TTL settings, requires confirmation,
and reports each changed hostname.

## Cloudflare Security

The **Security** tab lists primary hosted websites and manages only rules
created by Hosting Control. It can apply a sensitive-path block, an XML-RPC
managed challenge, and a WordPress login rate limit. Existing user-created
Cloudflare rules are not changed or displayed.

The WordPress login preset is compatible with Cloudflare Free: it blocks an IP
after five requests to `/wp-login.php` in 10 seconds for 10 seconds. Cloudflare
Free restricts the available expression fields, so this rule applies across the
selected Cloudflare zone rather than to only one hostname. Free accounts permit
one rate-limiting rule per zone.

Use a separate token with zone read and Rulesets/WAF write access available for
the token type and account. Cloudflare permission labels differ for user-owned
and account-owned tokens. The fresh installer asks for this token independently
from the DNS token, and it can be changed or cleared later in **Settings**.

NPM restores `CF-Connecting-IP` only for connections received from published
Cloudflare address ranges. Direct connections cannot supply a trusted visitor
header. NPM access logs and the private internal nginx therefore use the
restored visitor address instead of the Cloudflare edge address. The small
source-built NPM image keeps NPM's automatic Cloudflare range updates and
changes its trusted visitor header from `X-Real-IP` to `CF-Connecting-IP`.

The legacy host-specific `backup_websites.sh` remains excluded from Git and is
not invoked or modified by this panel.

## Additional Documentation

- [docs/UI_GUIDE.md](docs/UI_GUIDE.md): panel guide covering every workspace and control
- [docs/SECURITY.md](docs/SECURITY.md): threat model, secret handling, audits, and credential rotation
- [AGENTS.md](AGENTS.md): engineering handoff, safety rules, and change map
- [STACK_OVERVIEW.md](STACK_OVERVIEW.md): runtime ownership and provisioning flow
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): service and module design
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): environment and persistent state
- [docs/API.md](docs/API.md): authenticated panel API route index
- [docs/OPERATIONS.md](docs/OPERATIONS.md): deployment, rollback, and diagnostics
- [ui-manager/README.md](ui-manager/README.md): panel-specific configuration
