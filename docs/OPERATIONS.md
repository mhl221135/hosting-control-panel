# Operations Runbook

## Fresh Installation

Use `bootstrap.sh` from the public repository or run
`sudo ./scripts/install.sh --configure` from an existing checkout. Installation
creates the storage tree, writes a mode-600 `.env`, copies missing active
configuration, builds images, validates Compose, and starts the stack.

An installation is not disposable after first start. Its state lives outside
the source checkout under `HOSTING_ROOT`.

## Standard Upgrade

```bash
cd /media/ssdmount/websites-v2/sources
sudo ./scripts/upgrade.sh
```

The script refuses tracked local edits, fast-forwards `main`, validates Compose,
pulls upstream images, rebuilds custom images, recreates changed services, and
runs explicit config migrations. Add `--production` to update/start GoAccess.

Upgrades do not replace `app-data`, `websites`, `backups`, or active copied
configuration.

## Narrow Deployment

For a tested panel-only change:

```bash
git pull --ff-only
docker compose build hosting-ui
docker compose up -d --no-deps --force-recreate hosting-ui
docker compose ps hosting-ui
docker logs --tail 100 hosting-ui
```

This signs out panel sessions but leaves website traffic and data services
running. Use the full upgrade script when Compose, migrations, or multiple
images change.

## Pre-Deployment Checks

```bash
node --check ui-manager/app/server.js
node --check ui-manager/app/public/app.js
node --test ui-manager/app/test/*.test.js
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
docker logs --tail 100 hosting-ui
docker logs --tail 100 hosting-nginx
docker logs --tail 100 hosting-php-fpm
```

Test one public website through NPM and confirm `git log -1 --oneline` in the
deployed checkout matches the intended commit.

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

## Backup Verification

Do not treat file existence as proof of a backup. Periodically verify:

1. each set has `website.tar.gz`, `database.sql.gz`, and `manifest.json`;
2. `tar -tzf` lists the archive;
3. `gzip -t` passes for the database dump;
4. manifest domain, document root, and database match;
5. a non-production restore can boot WordPress.

The app-data set similarly requires `app-data.tar.gz`, `databases.sql.gz`, and
its manifest.

## Common Diagnostics

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
