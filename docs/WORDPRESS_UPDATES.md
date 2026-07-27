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

## Transaction Boundary

Each job holds the server-heavy and website conflict locks and performs:

1. a complete website archive and consistent database dump;
2. archive listing and compressed database integrity verification;
3. WordPress maintenance-mode activation;
4. only the selected update commands, including the matching database upgrade
   after a WordPress core update;
5. WordPress bootstrap and database checks;
6. maintenance-mode deactivation;
7. public front-page and internal admin-route HTTP checks;
8. Redis/FastCGI invalidation only after successful validation.

Any update or health failure invokes the existing complete files/database
restore engine. The job then validates the restored WordPress installation and
HTTP routes. Failure reports include both the original error and whether
rollback completed. The pre-update backup remains in normal backup history.

Uploaded plugin and theme ZIPs are resolved again from the package library at
execution time, copied temporarily into `hosting-php-fpm`, installed with
WP-CLI `--force`, and removed from the temporary path afterward.

## Safety

- Updates are manual and one website per job.
- Jobs are non-cancellable after queueing because interruption could leave an
  application between package writes and rollback.
- Other server-heavy or same-site work cannot overlap.
- Passwords and database dumps are never placed in job payloads or results.
- Persistent package pins remain future work. Until then, unselected packages
  are excluded explicitly from every manual operation.
