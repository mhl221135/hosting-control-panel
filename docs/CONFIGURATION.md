# Configuration And State

## Installation Environment

`.env` is created interactively and excluded from Git. `.env.example` documents
the supported keys.

| Variable | Purpose | Persistence behavior |
|---|---|---|
| `HOSTING_ROOT` | Absolute installation/data root | Compose mount source |
| `INSTALLATION_ROLE` | `standalone`, `primary`, or `standby` | Initial value; machine marker is authoritative |
| `SERVER_ID` | Unique 1-64 character machine identity | Stored in the machine marker |
| `HOSTING_PEER_HEALTH_URL` | Optional HTTPS `/ha/v1/status` URL for the paired server | Token-authenticated, read-only status probe |
| `HOSTING_PEER_API_TOKEN` | Shared random pairing credential, at least 32 characters | Sent only as a Bearer header; never returned by either API |
| `HOSTING_SYNC_PEER_DEVICE_ID` | Expected project Syncthing device ID of the paired server | Restricts panel sync connectivity to the intended peer |
| `HOSTING_PEER_SERVER_ID` | Expected identity returned by the peer health endpoint | Rejects an unrelated healthy endpoint as the peer |
| `HA_PEER_SSH_HOST` | Root SSH target used by promoted-primary rebuild/failback workflows | Stored only in the machine-local `.env` |
| `HA_PEER_ROOT` | Peer installation root | Defaults to `/media/ssdmount/websites-v2` |
| `HA_PEER_SYNC_DEVICE_ID`, `HA_LOCAL_SYNC_DEVICE_ID` | Exact Syncthing identities used by rebuild/failback | Required before those panel actions can run |
| `HOSTING_MACHINE_STATE_DIR` | Non-replicated role/state root | Defaults to `/etc/hosting-control` |
| `UI_DATA_DIR` | Panel state directory | Standby defaults to machine-local `ui-data` |
| `BACKUPS_DIR` | Absolute backup storage directory | Mounted at `/srv/backups` in the panel |
| `EXPORTS_DIR` | Absolute portable website-export directory | Mounted at `/srv/exports` in the panel |
| `UI_ADMIN_EMAIL` | First panel account email | Used only if account state is absent |
| `UI_ADMIN_PASSWORD` | First panel password | Hashed when account state is created |
| `UI_SETTINGS_KEY` | Stable secret-encryption material | Overrides generated key file |
| `HOSTING_AGENT_TOKEN` | Private panel-to-agent bearer token | Generated on install/upgrade; never shown in the panel |
| `BILLING_ADMIN_EMAIL` | First billing account email | Used only if billing account state is absent |
| `BILLING_ADMIN_PASSWORD` | First billing account password | Hashed when billing account state is created |
| `BILLING_API_TOKEN` | Private panel-to-billing bearer/HMAC key | Generated on install/upgrade |
| `BILLING_BACKUP_RETENTION` | Number of verified SQLite snapshots | Defaults to 14; bounded to 1-100 |
| `BILLING_SETTINGS_KEY` | Optional stable WooCommerce secret-encryption material | Overrides the generated billing key file |
| `JOB_HISTORY_LIMIT` | Maximum durable job records | Defaults to 250; active work is never pruned |
| `PROVISION_CREDENTIAL_TTL_HOURS` | One-time provisioning credential lifetime | Defaults to 24; bounded to 1-168 hours |
| `TRANSFER_BUNDLE_UPLOAD_LIMIT_BYTES` | Maximum resumable portable bundle upload | Defaults to 16 GiB |
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
| `EXPORT_DOWNLOAD_MAX_BYTES` | Maximum size of one authenticated panel artifact download | `536870912` (512 MB) |

The installer writes `HOSTING_MACHINE_STATE_DIR/role.json` atomically and
refuses to overwrite a marker whose role or server identity differs. Editing
`.env` or replicated application data cannot promote a standby. Controlled
role transition remains part of the pending promotion workflow.
The panel persists only ingress-mode metadata in
`UI_DATA_DIR/server-role.json`. Role and server identity are read only from the
machine marker and cannot be changed through this settings file.
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
| `server-role.json` | ingress mode only; never role or server identity | no |
| `integration-settings.key` | generated AES key if env key is absent | yes |
| `site-state.json` | cache, OPcache, Redis, backup switches (written atomically with the generated `cache.map`) | no |
| `backup-settings.json` | global enablement, local time, retention | no |
| `performance-settings.json` | validated performance values | no |
| `dns-presets.json` | Cloudflare record template sets | no |
| `cloudflare-ip-addresses.json` | reusable server IPv4 list | no |
| `cloudflare-automation-settings.json` | provisioning presets and protected incident addresses | no |
| `cloudflare-automation-history.json` | bounded bulk apply and rollback state | no |
| `cloudflare-incidents.json` | temporary mitigation audit and expiry state | no |
| `wordpress-inventory.json` | latest bounded read-only WordPress package snapshot | no |
| `wordpress-update-history.json` | bounded controlled-update and rollback audit | no |
| `wordpress-update-pins.json` | per-site core/package update exclusions and last editor metadata (atomic; fail-closed on corruption) | no |
| `default-pool.json` | default PHP pool choice | no |
| `pool-presets.json` | low/medium/high worker definitions plus per-profile `estimated_memory_mb` planning value | no |
| `php-fpm-audit.json` | bounded atomic PHP-FPM profile save/preview/apply audit | no |
| `runtime-config-audit.json` | bounded atomic runtime mutation audit (pool/host/provision/import/opcache/removal) | no |
| `image-optimization-status.json` | persisted bulk-job progress | no |
| `jobs.json` | durable queue, progress, results, and bounded history | no; secret fields are rejected |
| `provisioning-credentials.json` | encrypted, expiring one-time provisioning records | yes |
| `provisioning-credentials.key` | generated AES-256-GCM key for those records | yes |
| `ipinfo-cache.json` | bounded normalized IP enrichment results, expiring after 24 hours | no |
| `telegram-command-state.json` | Bot API cursor and bounded command audit metadata | no |
| `wordpress-packages/` | ZIPs and package metadata | user content |

The non-runtime settings files inventoried in `docs/API.md` are written
atomically (temp-file + rename, mode 0600) by their owning modules and fail
closed on validation or write errors. Secret values are stored only inside the
encrypted settings files; a blank or omitted secret field preserves the current
value and only an explicit clear flag removes it. Manager-backed mutations still
listed in `TODO.md` are outside this completed inventory.

These files are operational data, not source. Back them up, but never commit
them.

## Billing State

`app-data/billing` contains `billing.sqlite` plus its WAL/SHM files and the
independent billing administrator hash. `${BACKUPS_DIR}/billing` contains
atomic snapshot directories with `billing.sqlite` and `manifest.json`. Neither
tree belongs in Git. The service has no access to panel state, website files, or
the hosting MySQL database. `woocommerce-settings.json` contains only encrypted
provider secrets; `woocommerce-settings.key` is the generated key when
`BILLING_SETTINGS_KEY` is absent. Losing both the external and generated key
makes those provider secrets unrecoverable.

Reminder schedule, last-run date, delivery keys, attempts, and remote delivery
IDs live in `billing.sqlite`. `NOTIFICATION_API_URL` is an internal Compose
value pointing at `hosting-ui`; both services receive the same
`BILLING_API_TOKEN`. Notification provider credentials remain only in
`app-data/ui-manager`.

The remote WordPress enforcement enrollment backend stores only hashes in
`billing.sqlite`: `enrollment_codes.code_hash` is a SHA-256 hash of the
one-time enrollment code and `wp_installations.credential_hash` is a SHA-256
hash of the per-installation credential. Plaintext codes and credentials are
never persisted, logged, audited, or exported; they are revealed at most once
during creation or exchange. These tables are never included in portable CSV
exports.

Signing-key material is stored in the `signing_keys` table (`billing.sqlite`).
Private keys are encrypted with AES-256-GCM using the service's existing key
material; only public keys are returned by the remote API. Signing is
unconfigured by default and requires `BILLING_SETTINGS_KEY` to be set before the
first key is initialized. Plaintext private keys are never returned, logged,
audited, backed up, or exported. Verified SQLite backups contain only the
AES-256-GCM encrypted active-key blob. Recovery therefore also requires the
matching `BILLING_SETTINGS_KEY`, which must be kept in an independent secret
store and is intentionally absent from backup artifacts.

Remote WordPress plugin state uses three non-autoloaded WordPress options named
`hostpilot_remote_config`, `hostpilot_remote_entitlement`, and
`hostpilot_remote_status`. The installation credential inside the config is
encrypted with libsodium secretbox and a key derived from `AUTH_KEY` and
`SECURE_AUTH_KEY`; changing those salts requires re-enrollment.

`app-data/ui-manager/billing-observer-settings.json` stores only the
disabled-by-default poll interval and freshness policy. Compose also supplies
the internal `ENTITLEMENT_REFRESH_API_URL` to billing. It carries no secret;
requests use `BILLING_API_TOKEN`, and scheduled polling must remain enabled
while local enforcement is armed.
`billing-entitlements-lkg.json` is the atomic last verified entitlement
response plus sanitized local matching results. Both files are mode `0600`;
the shared API token remains only in `.env`.

`app-data/ui-manager/billing-provisioning-settings.json` stores non-secret
defaults for new-site registration: enabled state, free/renewal months, prices,
currency, grace days, and timezone. It contains no billing administrator,
WooCommerce, or API credentials.

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

The complete `php-fpm` configuration directory is mounted at
`/runtime-php-fpm`; the main configuration includes only its `pools.conf`.
This directory bind is required because the panel replaces `pools.conf`
atomically and a single-file Docker bind would continue reading the replaced
file's old inode.

The installer copies a template directory only when its marker is missing. It
does not generally refresh active configuration during upgrades. Required
directive migrations therefore use explicit idempotent steps; install and
upgrade ensure that the runtime `pools.conf` include is present.

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

Each host may set `MYSQL_SERVER_ID`, `MYSQL_INNODB_BUFFER_POOL_SIZE`,
`MYSQL_INNODB_REDO_LOG_CAPACITY`, `MYSQL_MAX_CONNECTIONS`, and
`REDIS_MAXMEMORY` in its private `.env`. `PHP_GLOBAL_INI_PATH` can point at a
machine-local global PHP configuration outside replicated `app-data`. This is
required for a smaller standby: restoring primary app-data must not silently
apply the primary's OPcache budget to the standby. The same file is mounted
writable into the panel's managed PHP configuration path, so performance
changes after promotion continue to update the active file. It must therefore
be owned by the panel uid/gid (`33:33`) and remain private (`0640`).

The initial 8 GB standby profile uses a unique MySQL server ID, 1 GiB InnoDB
buffer pool, 512 MiB redo capacity, 100 connections, 256 MiB Redis, and a
machine-local 2 GiB OPcache configuration. These are conservative promotion
defaults, not a promise that every workload fits; inspect capacity before
cutover. Set `STANDBY_PROFILE_NAME=standby-8gb`; promotion preflight fails when
the profile name, server ID, configured limits, or active OPcache file do not
match the bounded standby policy.

`scripts/configure.sh --role standby` writes these defaults automatically for
new installations. Existing standbys retain their private `.env` and should be
updated only through a reviewed preparation cycle.

For a 16 GB standby that is intended to match a 16 GB primary, use
`STANDBY_PROFILE_NAME=standby-16gb`. The readiness policy permits up to 4 GiB
InnoDB, 2 GiB Redis, and 8 GiB OPcache for that profile. Keep a unique
`MYSQL_SERVER_ID`; the remaining values may match the primary after accounting
for other workloads on the standby host.

## Ports And Network

Published by default: `80`, `81`, `443`, `8687`, `8787`, and `8484`. File Browser,
internal nginx, PHP-FPM, MySQL, and Redis are reachable by container name on
`hosting-net` and need no host ports.

NPM hosts for internal stack services should use container name and container
port. Unrelated containers on other networks must use a host/LAN route or a
separate deliberate network design; do not attach them to `hosting-net` silently.
