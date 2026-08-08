# Operations Runbook

## Fresh Installation

Use `bootstrap.sh` from the public repository or run
`sudo ./scripts/install.sh --configure` from an existing checkout. Installation
creates the storage tree, writes a mode-600 `.env`, copies missing active
configuration, builds images, validates Compose, and starts the stack.

An installation is not disposable after first start. Its state lives outside
the source checkout under `HOSTING_ROOT`.

For a replica, run the installer with `--role standby --server-id <unique-id>`.
Verify `/etc/hosting-control/role.json` and confirm only `hosting-agent` and
`hosting-ui` are running. MySQL, NPM, nginx, PHP, Redis, billing, File Browser,
and phpMyAdmin intentionally remain stopped. Do not edit the marker to promote
the server; pairing, verified backup reception, and controlled promotion are
separate pending phases in `docs/HIGH_AVAILABILITY.md`.

Before enabling billing payments, route a dedicated HTTPS hostname through NPM
to `hosting-billing:8787`, save that exact origin as the public billing URL, and
configure the WooCommerce **Order updated** webhook at
`/webhooks/woocommerce`. Complete the live qualification in `TODO.md` before
issuing a client link. Billing code deployment alone leaves the integration
inert when no provider settings are saved.

Use **Settings > Billing entitlement observer > Refresh now** and confirm the
snapshot is fresh and inventory drift is understood. Scheduled polling is
disabled by default. Local enforcement is separately gated: its global switch
defaults off, the pilot allowlist defaults empty, and its managed nginx map is
empty after installation. Do not enable either gate for a client domain before
the dedicated test-service pilot in `TODO.md`. If behavior is uncertain, type
`DISABLE` and use **Disable and restore all**; this clears redirects without
changing renewal dates or website data. Review **Recent enforcement
transitions** after every pilot drill. Nginx apply or rollback failures create
critical notifications through any enabled Telegram or SMTP channel even when
ordinary severity filters are disabled.

Keep scheduled billing entitlement observation enabled for every enforcement
pilot. A verified paid webhook requests an immediate internal refresh and
reconcile, but the callback is intentionally fail-open and cannot undo a
durable payment. Scheduled polling is the recovery path after callback or panel
outage.

Run `scripts/qualify-billing-pilot.sh` after each deliberate pilot-state
transition. The command is read-only and fails unless the allowlist contains
exactly the selected local website, the signed snapshot is fresh, and the
public/map behavior matches the expected state. Never paste its domain argument
into committed documentation or support logs.
Follow `docs/BILLING_PILOT_RUNBOOK.md` for the complete state, payment, outage,
rollback, and completion sequence.

Billing reminders are also inert after deployment because their daily schedule
defaults to disabled. Before enabling it, confirm Telegram and/or SMTP in the
hosting panel, open Billing **Reminders**, review every due service and date,
run one manual batch, inspect delivery history, and only then enable a daily
time.

Remote WordPress signing is also inert until an administrator initializes a
key. Before initialization, verify `BILLING_SETTINGS_KEY` is stored outside the
host and its backups. Record the active key ID before rotation and submit that
same value as `expected_key_id`; a `409` means another operator changed the key
and the status must be refreshed. Keep the previous public key through its
overlap window unless an emergency compromise requires early retirement.

Build the fail-open remote package with
`./scripts/build-remote-wordpress-plugin.sh`; installation and enrollment are
documented in `docs/REMOTE_WORDPRESS_PLUGIN.md`. This package currently observes
and verifies entitlement only. Frontend suspension remains a separate pilot.

## Standard Upgrade

```bash
cd /media/ssdmount/websites-v2/sources
sudo ./scripts/upgrade.sh
```

The upgrade generates a missing private control-agent token and runs the
idempotent panel-storage permission migration before recreating services.
`hosting-ui` then starts as UID/GID `33:33`. The upgrade also runs the
idempotent Static HTML route migration. Legacy sites marked `static` that
contain PHP files are reclassified as Generic PHP and retain or recover a pool.
Pure static routes disable PHP and remove only pools no longer referenced by
another route. The migration validates nginx and PHP-FPM and rolls active
configuration back if validation fails.

Preview that migration without writing active configuration:

```bash
docker compose run --rm --no-deps hosting-ui \
  node /app/cli/migrate-static-routes.js --dry-run
```

The script refuses tracked local edits, fast-forwards `main`, validates Compose,
pulls upstream images, rebuilds custom images, recreates changed services, and
runs explicit config migrations. When `git pull` changes the source commit, the
script re-executes its newly pulled version before reading new environment or
deployment requirements.

Upgrades do not replace `app-data`, `websites`, `backups`, or active copied
configuration.

## Narrow Deployment

For a tested panel-only change that does not alter the control-agent contract:

```bash
git pull --ff-only
docker compose build hosting-ui
docker compose up -d --no-deps --force-recreate hosting-ui
docker compose ps hosting-ui
docker logs --tail 100 hosting-ui
```

This signs out panel sessions but leaves website traffic and data services
running. Use the full upgrade script when Compose, migrations, or multiple
images change. Changes to Docker command shapes require coordinated
`hosting-ui` and `hosting-agent` builds and must never use this narrow path.

## Pre-Deployment Checks

```bash
node --check ui-manager/app/server.js
node --check ui-manager/app/public/app.js
node --test ui-manager/app/test/*.test.js
node --test control-agent/test/*.test.js
docker build -t hosting-billing:test billing-service
docker run --rm hosting-billing:test npm test
sh -n bootstrap.sh scripts/*.sh
docker compose config --quiet
git diff --check
```

For frontend work, inspect the real panel at desktop and mobile widths, exercise
the changed control, and inspect its network response.

## Post-Deployment Checks

```bash
docker compose ps
docker exec hosting-nginx nginx -t
docker exec hosting-php-fpm php-fpm -t
curl -I http://127.0.0.1:8687/
curl -I http://127.0.0.1:8787/health
docker logs --tail 100 hosting-ui
docker logs --tail 100 hosting-agent
docker logs --tail 100 hosting-billing
docker logs --tail 100 hosting-nginx
docker logs --tail 100 hosting-php-fpm
```

Test one public website through NPM and confirm `git log -1 --oneline` in the
deployed checkout matches the intended commit.

Confirm the panel sandbox after a full upgrade:

```bash
docker inspect -f \
  'user={{.Config.User}} caps={{json .HostConfig.CapDrop}} security={{json .HostConfig.SecurityOpt}}' \
  hosting-ui
docker inspect -f '{{range .Mounts}}{{println .Destination .RW}}{{end}}' hosting-ui
docker exec hosting-ui id
```

Expected values are user `33:33`, `["ALL"]` capability drop,
`no-new-privileges:true`, no Docker socket mount, and `false` for the broad
`/srv/app-data` mount.

On a host where `testsite.example.com` is not configured and its directory
does not exist, the qualification drill exercises authenticated provisioning,
local-origin health, backup, restore, portable export, and complete cleanup:

```bash
docker exec -i hosting-ui node < scripts/qualify-unprivileged-panel.js
```

The drill is hard-coded to that temporary hostname, refuses pre-existing state,
creates no DNS/NPM/certificate resources, and cleans up both completed and
partially created local resources. It passed on the upgraded OPI5 production
stack on 2026-07-28.

## Rollback

Source rollback and data rollback are different operations.

- For a code regression, deploy a new revert commit and rebuild only the
  affected image. Do not use `git reset --hard` on production.
- For failed runtime configuration, identify the matching panel-generated
  `.bak` snapshot and validate it before restoration.
- For a website/database regression, use one complete panel backup set. Never
  pair an archive with an unrelated dump.
- Application-data restore requires a maintenance window and explicit service
  shutdown. It is intentionally not a panel button.

## Host Failover

Do not start a second writable stack for the same websites without first
fencing the old primary. The supported baseline is manual recovery from
replicated, verified backup sets. See
[HIGH_AVAILABILITY.md](HIGH_AVAILABILITY.md) for state ownership, RPO/RTO
levels, promotion order, public traffic switching, validation, and failback.

## Backup Verification

Do not treat file existence as proof of a backup. Periodically verify:

1. each set has `website.tar.gz`, `database.sql.gz`, and `manifest.json`;
2. `tar -tzf` lists the archive;
3. `gzip -t` passes for the database dump;
4. manifest domain, document root, and database match;
5. a non-production restore can boot WordPress.

The app-data set similarly requires `app-data.tar.gz`, `databases.sql.gz`, and
its manifest.

New site and app-data sets use manifest version 2 and record each artifact's
byte length and SHA-256 digest. Restore verifies these values before extracting
files or importing SQL. Existing version-1 sets remain structurally verifiable
and restorable until normal retention replaces them.

Per-site restore uses a scoped MySQL client session that remains strict but
omits `NO_ZERO_DATE` and `NO_ZERO_IN_DATE` so legacy WordPress/WooCommerce table
defaults can be recreated. This does not alter the server's global SQL mode.
Run `scripts/qualify-local-recovery.sh` after database or backup changes.

## Website Deletion

Use the panel's **Delete** tab instead of manually removing files or database
rows. Refresh the preview, inspect disabled/shared resources, retain the default
final backup, and type the domain exactly. Historical backups remain unless
**Stored website backups** is explicitly selected.

Deletion may stop after an external NPM or Cloudflare error while local files
remain intact. Refresh the preview before retrying; already removed external
resources will no longer be selected. After success, verify that primary and
alias hosts are absent from NPM and `sites.map`, the pool is absent from
`pools.conf`, and retained backup archives remain readable.

## Common Diagnostics

### Provision import upload returns 413

The panel streams uploads and does not need PHP limits, but its NPM proxy host
must allow the request body. Add the following to that proxy host's Advanced
configuration and save it:

```nginx
client_max_body_size 8g;
client_body_timeout 1h;
proxy_request_buffering off;
proxy_connect_timeout 60s;
proxy_send_timeout 1h;
proxy_read_timeout 4h;
send_timeout 1h;
```

Imports use resumable 16 MB chunks. Failed chunks retry without restarting the
full archive, and the page blocks duplicate provisioning submissions.

The bundled helper applies this only to the named panel proxy host and is safe
to rerun:

```bash
docker exec hosting-ui node /app/cli/configure-panel-upload.js ui.example.com
```

Uploaded files are staged under `imports/ui-provision`. Successful imports and
staging older than 24 hours are removed automatically. Failed imports retain
their staged inputs so the form can be retried until expiration.

The final import runs in **Jobs**, so closing the upload page does not stop it.
Cancellation is honored only before archive extraction/import or runtime
configuration mutation. WordPress credentials can be revealed once from a
successful job and expire after 24 hours; they cannot be recovered afterward.

Transfers uses the same staging root for resumable complete-bundle uploads.
After a connection stops, reselect the same file and click **Upload and stage
bundle**; the panel queries the committed server offset before sending more
chunks. Archive extraction and checksum validation continue in Jobs after the
upload. Failed validation retains the upload for up to 24 hours.

### Website returns 502

1. Check the NPM host forwards to `hosting-nginx:80` over HTTP.
2. Check `hosting-nginx` and `hosting-php-fpm` are up.
3. Compare the host row in `sites.map` with the listener in `pools.conf`.
4. Run nginx/PHP configuration tests.
5. Inspect PHP-FPM logs for pool or permission errors.

### WordPress files are not writable

Website files should normally be owned by UID/GID `33:33`, matching PHP-FPM.
Inspect ownership before changing it. Avoid world-writable permissions.

### Redis enablement fails

Confirm `wp-config.php` is writable by UID 33, `hosting-redis` resolves on
`hosting-net`, WP-CLI works in `hosting-php-fpm`, and the Redis Cache plugin can
be installed. Redis is unrelated to OPcache and FastCGI.

### FastCGI enablement or purge fails

Inspect `site-state.json` and generated `cache.map`, validate nginx, and confirm
the reload action targets `hosting-nginx`. Purge increments the cache version.

### Cloudflare says no active zone

Verify the token can read the zone, the domain is correct, and an account-owned
token has its account ID. The client walks parent labels to find the longest
active zone for subdomains.

### Automatic SSL is not attached after provisioning

The panel waits up to two minutes for every requested certificate name to
resolve before contacting ACME. If DNS remains unavailable, provisioning keeps
the valid local site and NPM host but reports the unresolved names as an NPM
warning. Correct DNS and use **DNS & SSL -> Issue SSL** to retry.
For zones managed by the configured Cloudflare DNS token, the panel uses DNS-01
validation and leaves proxied website records unchanged. The token requires DNS
edit permission so NPM can create and remove the temporary ACME TXT record.

### Cloudflare Security authentication fails

Use the separate Security token with zone discovery and Rulesets/WAF permissions
supported by its token type and account. Reduce broad diagnostic permissions
after the exact requirement is known.

### Rate-limit period entitlement error

Cloudflare Free accepts only a 10-second period and mitigation. The committed
login preset uses five requests per 10 seconds and applies to `/wp-login.php`
across the entire zone. Free allows one rate-limit rule per zone.

### Image optimization appears stuck

Check `/api/sites/images/status`, `image-optimization-status.json`, container
CPU/I/O, and ImageMagick output. The bulk task is sequential and waits for the
backup/restore lock. Existing smaller WebP sidecars are skipped.

For daily incremental runs, enable the global image schedule in **Settings** and
select **Images daily** on each intended primary website. The scheduler runs once
per local calendar day after the configured time and defers while the shared
operation lock is occupied.

### PHP-FPM profile audit history

Successful profile saves and applies, failed applies after execution begins, and
non-mutating previews are recorded in
`app-data/ui-manager/php-fpm-audit.json`. The log is bounded to 250 events by
default (drop the youngest outside the window is automatic), written atomically,
and safely tolerates a missing or corrupted file by starting fresh. View it from
Runtime's **PHP-FPM audit history** section or `GET /api/pool-presets/audit`.
Entries store only timestamps, operator, operation, pool/profile names, changed
field names, result/rollback status, and a bounded redacted error summary; they
never store passwords, tokens, environment values, website contents, full
configuration files, customer data, or request headers, so the file is not a
secret store and no dedicated rotation is required beyond the bounded retention.

### PHP-FPM capacity planning (advisory)

Each Low/Medium/High profile stores a validated `estimated_memory_mb` planning
value (defaults 96/128/192 MB, bounds 32-4096 MB). It is used only for the
Runtime **Worker capacity** summary and is never rendered into `pools.conf`.
Changing only an estimate never makes pools drift or trigger a reload.

Estimated worker memory per pool is the profile estimate multiplied by
`pm.max_children` (custom/drifted pools use a conservative 256 MB fallback,
reported separately). The absolute PHP memory-limit ceiling (configured PHP
memory limit × workers) is shown alongside and is not misrepresented as
guaranteed usage. Statuses compared against host RAM:

- **healthy**: estimated ≤ 50% and ceiling ≤ 75% of host RAM;
- **warning**: estimated > 50% or ceiling > 75%;
- **critical**: estimated > 75% or ceiling > 90%.

CPU worker slots per available core:

- **healthy**: ≤ 4 slots per CPU;
- **warning**: > 4 slots per CPU;
- **critical**: > 8 slots per CPU.

These are advisory guardrails, not hard blockers, because ondemand workers are
not permanently resident. Missing or zero host CPU/RAM and unreadable,
malformed, or excessive pool data are reported as `unknown` instead of as a
healthy empty system. Use the summary to bound worker counts and host RAM, then
reload clearly and verify traffic.

## Runtime Mutation Transactions And Port Verification

Every operation that creates or changes a PHP-FPM pool runs through the shared
`RuntimeConfigTransaction` in `lib/runtime-transaction.js`. It serializes
concurrent map/pool writes (so requests and background jobs cannot overwrite
each other), snapshots both files before mutating, and rejects stale previewed
work with a `409`. Proposed models are validated before any reload: ports must
be integers in 1-65535 with no duplicates; every PHP-enabled route must point at
an existing pool whose upstream agrees with its port; and pool sections must be
consistent (no duplicate/missing sections). Invalid or unreadable state fails
closed rather than being silently skipped.

The activation sequence is: write both files atomically (temp file + rename,
with timestamped backups) -> `nginx -t` and `php-fpm -t` -> reload PHP-FPM and
nginx -> verify every configured PHP-FPM port with bounded retries/backoff
(because a PHP-FPM reload is asynchronous). Success is reported only after every
required port, including newly allocated ports, accepts a TCP connection. On a
failure the prior files are restored atomically, re-validated, reloaded, and
re-verified; the original error is preserved and the rollback outcome
(`not-required`, `succeeded`, or `failed`) is reported distinctly. `rolled back`
is never reported unless restore validation, reload, and port verification all
succeeded.

The transaction lock is a shared directory under
`app-data/ui-manager/runtime-config.lock`, so the long-running panel and
one-shot transfer/migration containers cannot allocate or activate ports at the
same time. Every commit re-reads both source files after acquiring that lock;
stale proposals fail with `409` before backups or writes.

Pool creation and reclassification use a gap-aware allocator that fills gaps
instead of `max(existing)+1`, ignores malformed existing ports, refuses
exhausted or invalid ranges, and reserves ports under the transaction lock so
concurrent allocations cannot collide. Preset apply retains its own port
verification and is serialized under the same lock. This boundary does not own
website files, databases, DNS, or NPM cleanup; those remain owned by the
operations that already perform them.

Request bodies for the pool/host/preset routes are guarded: non-object bodies,
prototype-pollution keys, excessively deep, oversized or unknown structures, malformed hosts,
unsafe document roots, and invalid ports/tiers are rejected with bounded
errors before any write (see `lib/runtime-validation.js`). Valid existing state
remains accepted (backward compatible).

### Static route migration CLI boundary

`scripts/migrate-static-routes.js` is an offline upgrade-time migration. It is
**non-mutating by default**: it prints a plan and changes nothing unless run
with `--apply`. `scripts/upgrade.sh` passes `--apply`. Apply commits through the
shared `activateStaticMigration` activation (atomic writes of
`sites.map`/`pools.conf`/`default.conf`/`site-state.json`, model validation,
nginx + PHP-FPM validation and reload, and bounded port verification, with
verified rollback on failure). `--dry-run` prints the plan without mutating. Do
not run it against a live runtime outside an upgrade or without `--apply`.

### Runtime configuration audit

Runtime mutations (pool, host, provisioning, import, opcache, removal) are
recorded to `app-data/ui-manager/runtime-config-audit.json` (bounded 250,
atomic, mode 0600, tolerant of missing/corrupt files). It stores counts and
internal identifiers only — no domains, secrets, submitted payloads, or full
configuration contents — with redacted bounded errors. View it in Runtime's
**Runtime configuration history** section or `GET /api/runtime-config/audit`.
This is separate from the PHP-FPM preset audit, which records only profile
save/preview/apply.

### Non-runtime settings mutations

Performance, backup and off-site backup, notification, integration, health,
billing provisioning/observer/enforcement, Cloudflare automation, server IP,
and DNS-preset settings are written only after guarded body parsing (plain
object, prototype-pollution, depth/size/count, declared nested and top-level
unknown-field, and recursive CR/LF/NUL-control rejection — see
`lib/runtime-validation.js`) plus each
module's own bounds/enum/URL/hostname/port/schedule validation. All settings
persist atomically (temp-file + rename, mode 0600) and fail closed. Secrets are
kept only in the encrypted settings mechanism; leaving a secret field blank or
omitting it preserves the current secret, and only an explicit clear flag
removes it. Performance changes additionally roll back the previously generated
PHP/nginx/Redis/MySQL files if validation, reload, or application fails. The
full endpoint inventory is in `docs/API.md`.

### Site-state, maintenance, image, and update-pin recovery

Site-state switches, cache purge, image-optimization schedules, maintenance
settings, and WordPress update pins are validated through the shared guarded
parser with explicit schemas and capability restrictions (Redis/image
optimization only for WordPress; PHP controls rejected for static HTML; `www`
aliases are rejected as separately managed). Site-state mutations and cache
purge run through a single-lock site-state transaction coordinator that
snapshots `site-state.json`, `cache.map`, `sites.map`, and `pools.conf`, writes
them atomically, validates nginx + PHP-FPM, reloads the affected services,
verifies pool ports, and applies Redis integration inside the same coordinated
operation. A failure after execution begins restores every file and compensates
an attempted Redis change; pre-write validation failures do not reload services.
Each failure has a distinct rollback outcome. WordPress update pins fail closed: if
`wordpress-update-pins.json` is unreadable or corrupt, update exclusions are
blocked until the file is repaired, and an active update job blocks pin
changes. Image and maintenance settings persist atomically.

## NPM Internal Service Hosts

Use Docker DNS names and internal ports for stack services, for example
`hosting-ui:8687`, `hosting-phpmyadmin:80`, or `hosting-files:80`, because NPM
shares `hosting-net`. Use HTTP unless the target terminates TLS. Sending HTTP to
an HTTPS port, or HTTPS to an HTTP-only target, causes redirects, 400, or 502.

Do not add aliases as separate WordPress proxy hosts. Put primary and `www`
names on one NPM host and certificate.

## Production Safety Checklist

- Backup/restore and image work are idle before disk-heavy maintenance.
- The Git working tree is understood; local manifests remain uncommitted.
- The intended service list is explicit before `compose up`.
- Database and Redis ports remain unpublished.
- Secrets are absent from Git diff and command output.
- DNS/SSL mutations target the intended domain and zone.
- Public websites are checked after NPM/nginx/PHP changes.
- GitHub source and deployed commit are synchronized after completion.
