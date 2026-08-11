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

## Production Qualification

An initial production drill completed on 2026-07-27 using a temporary dedicated
website. It proved the workflow and found three fail-safe defects: a
browser-only dump flag used an unsafe durable-job field name, already-matching
maintenance-mode state was not idempotent, and application checks depended on
the public Cloudflare path. All three defects were corrected.

Three fully instrumented production drills then passed on 2026-07-28 using only
a dedicated disposable qualification hostname. Each drill provisioned fresh WordPress, created
Cloudflare DNS, NPM routing, and SSL, exercised a successful controlled update,
forced a package-install failure, restored the verified backup, and removed the
temporary site.

| Drill | Successful update | Success backup | Backup | Update | Rollback backup | Failed update | Rollback |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Core/theme A | core `6.9.5` to `7.0.2`; Twenty Twenty-Four `1.3` to current | 25,097,234 B | 5s | 16s | 27,404,186 B | 2s | 10s |
| Repository/uploaded | Akismet `5.3` to current; uploaded plugin `1.0.0` to `2.0.0` | 24,573,794 B | 5s | 9s | 24,598,176 B | 2s | 10s |
| Core/theme B | core `6.9.5` to `7.0.2`; Twenty Twenty-Four `1.3` to current | 25,095,520 B | 5s | 17s | 27,400,555 B | 2s | 10s |

For every instrumented drill:

- origin front/admin checks returned `200/302` after update and rollback;
- public HTTPS returned `200`;
- Telegram and SMTP reported `sent` for successful and failed jobs;
- cache purge completed as part of the guarded update and rollback paths;
- rollback reported `complete` and restored the expected uploaded-plugin
  version;
- post-cleanup verification found no panel site, website directory, backup set,
  active NPM host/certificate, exact Cloudflare DNS record, or temporary package
  library entry.

The first instrumented attempt exposed a package-staging ownership regression
after `hosting-ui` became unprivileged. ZIP streams were created by root with
mode `0600`, so PHP UID 33 could not read them. `hosting-agent:1.1` and
Current `hosting-ui` images create temporary package files as UID `33:33`; agent and
panel suites plus a live package-read probe passed before the drills were
repeated.

The repeated production-qualification gate is complete. Controlled updates
remain manual; no unattended schedule was enabled as part of qualification.
