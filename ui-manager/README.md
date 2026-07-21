# Websites Control Panel

The panel is built into the main Compose project and runs as
`hosting-ui` on port 8687.

## First login

Initial credentials come from `UI_ADMIN_EMAIL` and `UI_ADMIN_PASSWORD` in the
project `.env`. The default credentials force an account update after login.
The stored password is scrypt-hashed in `ui-manager/data/auth.json`.

## Settings

Open **Settings** in the panel to configure:

- Nginx Proxy Manager API URL, login identity, and password
- Cloudflare API token
- Separate Cloudflare Security API token
- MySQL container name and database/user prefix
- Global PHP, OPcache, FastCGI, Redis, and MySQL resource limits

NPM and Cloudflare secrets are encrypted at rest with AES-256-GCM. Use
`UI_SETTINGS_KEY` for a stable externally managed encryption key, or let the
panel create a restricted local key in its data directory.

The MySQL root password stays in the MySQL container environment and is never
stored by the panel.

## Cloudflare security

The **Security** tab applies narrowly scoped WAF and rate-limit presets to one
hosted website at a time. It uses a separate `CLOUDFLARE_SECURITY_API_TOKEN`
credential and never edits rules that were not created by Hosting Control.

## Statistics

The **Stats** tab collects runtime data only when opened or manually refreshed.
Server, container, PHP-FPM pool, Redis, and FastCGI snapshots are cached for 30
seconds. Website disk usage and the selected NPM access-log sample are cached
for five minutes. No background metrics database or permanent polling service
is required.

## WordPress provisioning

Open **Provision** to create a site, PHP-FPM pool, database and database user,
install WordPress, enable optional Redis/OPcache/FastCGI cache, and create the NPM
proxy host and certificate. Provisioning can create/update Cloudflare host DNS,
apply a named multi-record DNS preset, and install selected ZIP packages from the
persistent plugin/theme library. Generated credentials are shown once.

Fresh installations remove the Hello World post and close comments by default.
Bundled WordPress plugins and inactive bundled themes are removed unless their
retention controls are selected. If no custom theme is selected, the active
bundled theme remains so the new website has a functioning frontend.

## Sites and image optimization

Hosts that share the same document root and PHP-FPM pool are presented as one
website with aliases, even when an imported configuration has no canonical
redirect marker. Per-site and bulk image optimization preserve source images and
create smaller WebP alternatives. The bulk job runs one primary website at a
time, persists progress in `/app/data`, and does not overlap backup operations.

## Portable website migration

The host-level `scripts/export-websites.sh` and `scripts/import-websites.sh`
commands run `/app/cli/sites-transfer.js` inside this container. The CLI can
export configured sites with a JSON manifest, read a lightweight
`import-sites.json`, or adopt manually copied WordPress folders and timestamped
`.sql.gz` dumps. It reuses the panel's encrypted Cloudflare/NPM settings and
never writes those secrets to an export.

## Persistent and mounted paths

- `/app/data`: panel account, encrypted settings, site state, config backups,
  DNS presets, and uploaded WordPress package ZIPs
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
