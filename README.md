# Websites V2

Private, Docker-based multi-site WordPress hosting for ARM64 Linux. The stack
keeps the existing shared nginx/PHP architecture while adding an authenticated
control panel for site provisioning, runtime management, Nginx Proxy Manager,
Let's Encrypt, Cloudflare DNS, Redis, and FastCGI cache.

The deployment source lives at `/media/ssdmount/websites-v2`. Existing website
content and persistent application data remain under `/media/ssdmount/websites`
and the other host paths already defined in `docker-compose.yml`.

## Features

- Native panel login with scrypt password hashing, login throttling, secure
  cookies, session expiry, and CSRF protection
- Account email and password changes from the panel
- Site and per-site PHP-FPM pool management
- One-click WordPress download, configuration, installation, and admin setup
- Automatic MySQL database and user creation
- Nginx Proxy Manager proxy-host creation and Let's Encrypt certificate actions
- Cloudflare A, AAAA, CNAME, and TXT record management
- Per-site Redis object-cache enablement
- Per-site FastCGI page cache with versioned purge
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
global-nginx-internal
  |
  +--> FastCGI page cache (optional per site)
  |
  v
global-php-fpm (one pool per site)
  |
  +--> mysql-db
  +--> redis-mysweetdesign

Administrator
  |
  v
websites-config-ui :8687
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
|-- README.md
|-- STACK_OVERVIEW.md
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

## Requirements

- ARM64 or AMD64 Linux host
- Docker Engine
- Docker Compose v1.29+ or Docker Compose v2
- Existing writable host directories referenced by Compose
- DNS records pointing to the host when public websites are enabled
- Nginx Proxy Manager administrator or dedicated API account
- Optional Cloudflare API token with `Zone:Read` and `DNS:Edit`

## Configuration

Create the deployment environment file:

```bash
cp .env.example .env
chmod 600 .env
```

Set unique values for:

- `UI_ADMIN_EMAIL`
- `UI_ADMIN_PASSWORD`
- `UI_SETTINGS_KEY`
- `MYSQL_ROOT_PASSWORD`
- `MYSQL_APP_PASSWORD`
- `NPM_DB_PASSWORD`

NPM API and Cloudflare credentials may be left empty in `.env` and entered
later in the panel's **Settings** tab. They are encrypted with AES-256-GCM in
the persistent panel data directory.

The MySQL root password is never copied into panel settings. The installer
executes database operations inside the MySQL container, where the password is
already available through the container environment.

## Deploy on the ARM Host

```bash
cd /media/ssdmount/websites-v2
docker-compose config --quiet
docker-compose build websites-config-ui global-php-fpm
docker-compose up -d
```

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
| Redis | 6379 |
| MySQL | 3306 |
| phpMyAdmin | 8484 |

Router/firewall exposure is an independent host/network decision. The panel
does not modify router rules.

## First Login

Open `http://SERVER_IP:8687` or publish the panel behind your existing proxy.
Sign in using `UI_ADMIN_EMAIL` and `UI_ADMIN_PASSWORD`. Change the temporary
account details from **Account** after the first login.

The Settings tab contains connection tests for:

- Nginx Proxy Manager
- Cloudflare
- MySQL

## Provision a WordPress Site

1. Open **Provision**.
2. Enter the domain, website directory, title, administrator email, and user.
3. Choose the PHP pool tier.
4. Optionally enable `www`, Redis, FastCGI cache, NPM host creation, and SSL.
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

OPcache and FastCGI cache solve different problems:

- OPcache stores compiled PHP bytecode and is enabled globally.
- FastCGI cache stores complete anonymous HTML responses and is opt-in per site.

FastCGI cache bypasses logged-in users, WordPress administration, API and login
paths, query strings, non-GET requests, and common WooCommerce cart/session
cookies. Purging increments a per-site cache version and reloads nginx.

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
docker exec global-nginx-internal nginx -t
docker exec global-php-fpm php-fpm -t
```

Inspect status and logs:

```bash
docker-compose ps
docker logs --tail 100 websites-config-ui
docker logs --tail 100 global-nginx-internal
docker logs --tail 100 global-php-fpm
docker logs --tail 100 mysql-db
docker logs --tail 100 nginx-proxy-manager
```

GoAccess is production-only:

```bash
docker-compose --profile production up -d goaccess
docker-compose stop goaccess
```

## Resource Sizing

The default MySQL InnoDB buffer pool is 512 MB, suitable for the current 2 GB
ARM host. Increase it only when the host has enough memory for MySQL, PHP-FPM,
NPM, Redis, Docker, and other workloads without sustained swap pressure.

## Backups

Backup behavior was intentionally not modified as part of this project. The
host-specific `backup_websites.sh` is excluded from Git because it contains
deployment credentials. Review and test restore procedures separately before
production rollout.

## Additional Documentation

- [STACK_OVERVIEW.md](STACK_OVERVIEW.md): runtime ownership and provisioning flow
- [ui-manager/README.md](ui-manager/README.md): panel-specific configuration
