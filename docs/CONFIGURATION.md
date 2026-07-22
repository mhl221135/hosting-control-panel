# Configuration And State

## Installation Environment

`.env` is created interactively and excluded from Git. `.env.example` documents
the supported keys.

| Variable | Purpose | Persistence behavior |
|---|---|---|
| `HOSTING_ROOT` | Absolute installation/data root | Compose mount source |
| `BACKUPS_DIR` | Absolute backup storage directory | Mounted at `/srv/backups` in the panel |
| `EXPORTS_DIR` | Absolute portable website-export directory | Mounted at `/srv/exports` in the panel |
| `UI_ADMIN_EMAIL` | First panel account email | Used only if account state is absent |
| `UI_ADMIN_PASSWORD` | First panel password | Hashed when account state is created |
| `UI_SETTINGS_KEY` | Stable secret-encryption material | Overrides generated key file |
| `JOB_HISTORY_LIMIT` | Maximum durable job records | Defaults to 250; active work is never pruned |
| `PROVISION_CREDENTIAL_TTL_HOURS` | One-time provisioning credential lifetime | Defaults to 24; bounded to 1-168 hours |
| `NPM_API_URL` | NPM API endpoint | Environment fallback; editable in panel |
| `NPM_IDENTITY` | Initial NPM account/panel API identity | Existing NPM database wins |
| `NPM_SECRET` | Initial NPM password/panel API secret | Existing NPM database wins |
| `ACME_EMAIL` | Certificate registration email | Environment fallback; editable in panel |
| `FILEBROWSER_ADMIN_USERNAME` | First File Browser account | Existing database wins |
| `FILEBROWSER_ADMIN_PASSWORD` | First File Browser password | Existing database wins |
| `CLOUDFLARE_API_TOKEN` | DNS API token | Environment fallback; editable in panel |
| `CLOUDFLARE_SECURITY_API_TOKEN` | WAF/rulesets token | Environment fallback; editable in panel |
| `CLOUDFLARE_ACCOUNT_ID` | Account-owned token account | Environment fallback; editable in panel |
| `IPINFO_TOKEN` | Optional IPinfo API token | Environment fallback; encrypted when saved in panel |
| `MYSQL_SITE_PREFIX` | New site database/user prefix | Environment fallback; editable in panel |
| `MYSQL_ROOT_PASSWORD` | MySQL root credential | Initializes empty MySQL data only |
| `NPM_DB_USER` | NPM database account | Initializes empty MySQL data only |
| `NPM_DB_PASSWORD` | NPM database password | Initializes empty MySQL data only |
| `NPM_DB_NAME` | NPM database name | Initializes empty MySQL data only |

Changing bootstrap credentials in `.env` does not reset accounts already stored
in persistent data. Change the panel account inside the panel. Use upstream
administration procedures for existing NPM or File Browser accounts.

## Persistent Panel Files

Paths below are relative to `app-data/ui-manager`.

| File/directory | Content | Sensitive |
|---|---|---|
| `admin-account.json` | email and scrypt password record | password hash |
| `integration-settings.json` | endpoints and encrypted credentials | yes |
| `integration-settings.key` | generated AES key if env key is absent | yes |
| `site-state.json` | cache, OPcache, Redis, backup switches | no |
| `backup-settings.json` | global enablement, local time, retention | no |
| `performance-settings.json` | validated performance values | no |
| `dns-presets.json` | Cloudflare record template sets | no |
| `cloudflare-ip-addresses.json` | reusable server IPv4 list | no |
| `default-pool.json` | default PHP pool choice | no |
| `pool-presets.json` | low/medium/high worker definitions | no |
| `image-optimization-status.json` | persisted bulk-job progress | no |
| `jobs.json` | durable queue, progress, results, and bounded history | no; secret fields are rejected |
| `provisioning-credentials.json` | encrypted, expiring one-time provisioning records | yes |
| `provisioning-credentials.key` | generated AES-256-GCM key for those records | yes |
| `ipinfo-cache.json` | bounded normalized IP enrichment results, expiring after 24 hours | no |
| `wordpress-packages/` | ZIPs and package metadata | user content |

These files are operational data, not source. Back them up, but never commit
them.

## Active Runtime Configuration

Active copies live under `app-data/configs` and are bind-mounted into services.

| Path | Consumer | Writer |
|---|---|---|
| `nginx/nginx.conf` | `hosting-nginx` | installer, performance settings |
| `nginx/conf.d/default.conf` | `hosting-nginx` | installer, performance settings |
| `nginx/conf.d/sites.map` | nginx and panel | panel/importer |
| `nginx/conf.d/cache.map` | nginx and panel | site-state store |
| `php/global.ini` | `hosting-php-fpm` | installer, performance settings |
| `php-fpm/php-fpm.conf` | `hosting-php-fpm` | installer |
| `php-fpm/pools.conf` | PHP-FPM and panel | panel/importer |
| `wp/wp-global.php` | every WordPress request | installer/source template |

The installer copies a template directory only when its marker is missing. It
does not refresh active configuration during upgrades. Directive migrations
therefore need an explicit idempotent migration script.

## Cloudflare Credentials

Use separate least-privilege tokens for DNS and Security. DNS needs zone read
and DNS edit for managed zones. Security needs zone discovery and Rulesets/WAF
access supported by the account and plan. Cloudflare labels differ between
user-owned and account-owned tokens; account-owned tokens also require
`CLOUDFLARE_ACCOUNT_ID`.

Do not log token values. Connection tests should return status and API errors
without echoing credentials.

## Performance Defaults

The committed defaults target a 16 GB host that also runs other workloads:

- MySQL buffer pool: 2 GiB
- Redis max memory: 1 GiB with `allkeys-lru`
- OPcache memory: 512 MiB
- FastCGI cache disk maximum: 8 GiB
- PHP pool tiers: 3, 6, and 10 maximum workers

The panel renders managed PHP/nginx directives. MySQL and Redis values in
Compose are startup arguments; changing them requires container recreation.
Measure host memory before increasing limits.

## Ports And Network

Published by default: `80`, `81`, `443`, `8687`, and `8484`. File Browser,
internal nginx, PHP-FPM, MySQL, and Redis are reachable by container name on
`hosting-net` and need no host ports.

NPM hosts for internal stack services should use container name and container
port. Unrelated containers on other networks must use a host/LAN route or a
separate deliberate network design; do not attach them to `hosting-net` silently.
