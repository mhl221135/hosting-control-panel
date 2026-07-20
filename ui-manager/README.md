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
- MySQL container name and database/user prefix

NPM and Cloudflare secrets are encrypted at rest with AES-256-GCM. Use
`UI_SETTINGS_KEY` for a stable externally managed encryption key, or let the
panel create a restricted local key in its data directory.

The MySQL root password stays in the MySQL container environment and is never
stored by the panel.

## WordPress provisioning

Open **Provision** to create a site, PHP-FPM pool, database and database user,
install WordPress, enable optional Redis/FastCGI cache, and create the NPM
proxy host and certificate. Generated credentials are shown once.

## Persistent and mounted paths

- `/app/data`: panel account, encrypted settings, site state, and config backups
- `/srv/websites`: website files
- `/srv/configs/nginx`: internal nginx configuration
- `/srv/configs/php-fpm`: PHP-FPM pool configuration
- `/var/run/docker.sock`: controlled provisioning and service reload operations

## Deploy

From `/media/ssdmount/websites-v2/sources`:

```bash
docker-compose build hosting-ui hosting-php-fpm
docker-compose up -d hosting-ui hosting-php-fpm hosting-nginx
```

Before deployment, set a unique `UI_ADMIN_PASSWORD` and preferably
`UI_SETTINGS_KEY` in `.env`.
