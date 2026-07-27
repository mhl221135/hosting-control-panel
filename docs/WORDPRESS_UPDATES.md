# Controlled WordPress Updates

The **Maintenance** workspace provides manual, one-website-at-a-time WordPress
updates. It never schedules an update and never selects an update implicitly.

## Workflow

1. Run **Inventory versions** for the website.
2. Choose the website and explicit core, plugin, theme, or uploaded package
   updates. **Select all available** remains an operator action.
3. Run **Preview update**. The server refreshes WordPress metadata and rejects
   stale or unavailable selections.
4. Review exact current/target versions and safeguards.
5. Confirm **Apply reviewed update** and follow the durable job in **Jobs**.

Immediately before execution the job refreshes the preview again. A changed
version or package-library entry invalidates the preview.

## Persistent Exclusions

**Update exclusions** can block every update for one website or pin WordPress
core, installed plugin/theme slugs, and uploaded package-library entries. Each
site record stores an optional operator reason plus the last editor and change
time. Clearing every exclusion removes the record.

Pins are enforced server-side before preview inventory and again when the job
starts. The browser cannot bypass them, **Select all available** skips disabled
choices, and pin changes are rejected while that website has a queued or
running update. An unreadable pin file fails closed and prevents updates until
the file is repaired.

## Transaction Boundary

Each job holds the server-heavy and website conflict locks and performs:

1. a complete website archive and consistent database dump;
2. archive listing and compressed database integrity verification;
3. WordPress maintenance-mode activation;
4. only the selected update commands, including the matching database upgrade
   after a WordPress core update;
5. WordPress bootstrap and database checks;
6. maintenance-mode deactivation;
7. front-page and admin-route checks against `hosting-nginx` with the website
   `Host` header;
8. Redis/FastCGI invalidation only after successful validation.

Any update or health failure invokes the existing complete files/database
restore engine. The job then validates the restored WordPress installation and
HTTP routes. Failure reports include both the original error and whether
rollback completed. The pre-update backup remains in normal backup history.
Cloudflare, public DNS, and WAN availability are monitored separately by the
Health workspace and cannot create a false application rollback.

Uploaded plugin and theme ZIPs are resolved again from the package library at
execution time, copied temporarily into `hosting-php-fpm`, installed with
WP-CLI `--force`, and removed from the temporary path afterward.

## Safety

- Updates are manual and one website per job.
- Jobs are non-cancellable after queueing because interruption could leave an
  application between package writes and rollback.
- Other server-heavy or same-site work cannot overlap.
- Passwords and database dumps are never placed in job payloads or results.
- Unselected packages are excluded explicitly from every manual operation.

## Production Drill Record

The first production drill completed on 2026-07-27 using a temporary dedicated
website:

- fresh WordPress provisioning, Cloudflare DNS, NPM routing, and SSL succeeded;
- a repository plugin update completed all eight guarded stages after a
  verified files/database backup;
- an intentionally invalid test package failed after backup and reported
  `rollback complete`;
- WordPress, the restored package version, public HTTPS, internal nginx, PHP-FPM,
  MySQL, and notifications were verified;
- the temporary package, DNS record, NPM host and certificate, runtime route,
  PHP pool, database/user, files, panel state, and drill backups were removed.

The drill found and corrected three fail-safe defects: a browser-only dump flag
used an unsafe durable-job field name, already-matching maintenance-mode state
was not idempotent, and application checks depended on the public Cloudflare
path. Unattended schedules remain disabled until the repeated-drill criteria in
`TODO.md` are complete.
