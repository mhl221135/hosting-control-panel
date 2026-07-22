# Hosting Control UI Guide

This guide documents the authenticated Hosting Control panel shipped with
Websites V2. Production screenshots are intentionally excluded because hosting
inventories, certificate names, service routes, logs, account identifiers, and
resource data are sensitive even when passwords and API tokens are masked.

## Navigation and conventions

The left navigation contains the panel workspaces described below. The
header shows the signed-in account and provides **Sign out**. Green buttons are
primary actions, outlined buttons are secondary actions, and red buttons are
destructive actions.

Most integration pages operate on the website selected in the domain selector.
Aliases such as `www` are grouped under their primary site instead of appearing
as independent websites. Operations report progress and errors in the panel
notice area. Do not close the browser during an upload, but long-running server
jobs continue independently after the request has started.

## Sites

The Sites workspace is the daily operations view. Summary counters show
configured primary hosts, PHP pools, FastCGI-enabled sites, and Redis-enabled
sites. **Search domains** filters primary domains and aliases.

Each website row shows its document root, aliases, PHP-FPM pool and port, pool
profile, cache state, and backup state.

| Control | Function |
| --- | --- |
| **PHP profile** | Applies the selected Low, Medium, or High worker profile to the site's existing PHP-FPM pool. |
| **Daily** | Includes or excludes the site from scheduled and **Back up enabled sites** runs. The global website-backup switch can pause all sites without clearing these choices. |
| **Images daily** | Includes or excludes the site from the optional daily incremental WebP schedule configured in Settings. |
| **Back up** | Creates a complete website set containing files, a compressed database dump, and a manifest. |
| **Optimize images** | Scans WordPress uploads and creates missing WebP derivatives. Existing WebP files are skipped. |
| **Enable/Disable FastCGI** | Adds or removes the site from the anonymous-page cache map and reloads internal nginx. |
| **Enable/Disable Redis** | Installs/configures the WordPress Redis Cache integration and changes the site's Redis state. This control is shown only for WordPress websites. |
| **Enable/Disable OPcache** | Changes the per-site OPcache directive. OPcache itself remains a shared PHP service. |
| **Purge cache** | Increments the site's FastCGI cache version so previous cached responses are no longer used. |
| **DNS & SSL** | Opens the DNS & SSL workspace with this website selected. |
| **Optimize all images** | Processes primary websites sequentially and displays current domain and completed count. |

The Settings tab contains the global automatic image optimization switch and
daily start time. Turning the global switch off pauses every site's daily image
job without clearing individual **Images daily** selections.

FastCGI, Redis, and OPcache are separate layers. FastCGI stores complete
anonymous HTML responses, Redis stores WordPress objects, and OPcache stores
compiled PHP bytecode.

On phone-sized screens, backup scheduling, image scheduling, cache, backup,
image, and DNS commands move into one accessible site-action selector. The
header's section selector replaces the desktop
sidebar navigation, and statistics tables become labeled vertical records.
These layouts avoid horizontal page scrolling.

## Stats

Statistics are collected on demand; there is no permanent metrics database or
high-frequency background collector.

| Control or section | Function |
| --- | --- |
| **Refresh** | Collects a new server, container, cache, and PHP-FPM snapshot. |
| **Server load** | Shows 1, 5, and 15 minute host load averages. |
| **Memory used** | Shows host RAM consumption. |
| **Hosting disk** | Shows usage for the hosting storage filesystem. |
| **PHP worker memory** | Totals current PHP-FPM worker memory and active workers. |
| **Cache health** | Shows OPcache capacity/hit rate, Redis memory/hit rate/keys/evictions, and FastCGI disk usage. |
| **Container resources** | Shows a one-time Docker CPU, memory, and PID sample. |
| **Website PHP load** | Attributes active worker CPU and RAM to dedicated website pools. |
| **Inspect** | Opens recent per-site activity: file size, request count, transfer volume, status codes, source IPs, and requested paths. |
| **Look up** | Sends only that current public traffic IP to IPinfo and shows available location, ASN/network, hostname, and privacy/hosting indicators. |
| **Clear cache** | Removes normalized IPinfo results retained locally for up to 24 hours. |

Traffic details are based on a bounded recent access-log sample. They are useful
for diagnosis, not long-term analytics or billing. IPinfo is never called during
normal refreshes. Private, reserved, Cloudflare edge, and configured server
addresses are refused, and unavailable plan fields are labeled unavailable.

## Health

| Control or section | Function |
| --- | --- |
| **Run health check** | Immediately checks configured containers, MySQL, NPM, attached certificates, selected public websites, OPcache, and storage. |
| **Overall state** | Summarizes the latest check as healthy, warning, or critical. |
| **Active incidents** | Shows unresolved issues and when each one opened. |
| **Event history** | Shows opened, updated, and recovered transitions plus notification delivery state. |
| **Operational health monitoring** | In Settings, enables scheduled checks and controls interval, thresholds, and required containers. |
| **Public websites to check** | Opts selected hostnames into HTTPS checks through their public proxy path. Empty means no public requests. |

Checks do not generate repeated alerts while an incident remains unchanged.
Recovery creates a separate success notification.

## Jobs

The Jobs workspace is the durable activity view for backups, restores,
maintenance, and image optimization. Starting one of these operations returns
immediately; closing the page does not stop the server-side job.

| Control or section | Function |
| --- | --- |
| **Running / Queued** | Counts active work and work waiting for a conflict to clear. |
| **Needs attention** | Counts failed and partially successful records in retained history. |
| **Status / Type** | Filters the local view without deleting history. |
| **Cancel** | Cancels queued work immediately or requests running work to stop at its next safe checkpoint. |
| **Retry** | Creates a new linked attempt using the original non-secret operation payload. |
| **Refresh** | Reloads job state; active views also refresh every three seconds. |
| **Alert status** | Shows Telegram/SMTP delivery, retry, or failure state for the job outcome when notifications are enabled. |

Queued rows identify the active job blocking them. A panel restart preserves
queued work and history but marks interrupted running work failed, because an
external command cannot be assumed complete after the process disappears.

## Maintenance

The Maintenance workspace runs low-priority WP-CLI cleanup sequentially and
shares the same server job lock as backups and image optimization. It lists only
primary WordPress websites; HTML/PHP sites are excluded.

| Control | Function |
| --- | --- |
| **Enable weekly maintenance** | Enables the global weekly scheduler. It is off by default. |
| **Weekday / Start time** | Chooses one server-local weekly execution window. A missed start runs on the next scheduler check that day. |
| **Scheduled operations** | Selects expired transient cleanup, trash/spam removal, due WP-Cron execution, database optimization, and old-revision cleanup. |
| **Revisions retained per post** | Keeps 1-100 newest revisions for each post. The safe default is five. This value is shared by manual and weekly runs. |
| **Weekly** | Includes that WordPress website in scheduled runs without changing manual selection. |
| **Manual operations** | Selects the operations for the next manual batch. |
| **Select all / Clear** | Changes the current manual website selection. |
| **Preview revision cleanup** | Counts revisions that would be removed for selected websites without changing WordPress data. |
| **Run selected websites** | Starts a persisted sequential job and reports each website and operation independently. |

After a processed site, the panel invalidates its FastCGI cache generation. If
Redis is enabled for that site, its WordPress object cache is flushed as well.
An operation failure does not prevent the remaining operations or websites from
running.

Revision cleanup retains the configured newest revisions independently for
each parent post. The result records how many revisions were found, eligible,
and deleted. It is disabled in both operation lists by default.

## Provision

Provision creates either a WordPress runtime or an HTML/PHP runtime. Both receive
files, an isolated PHP-FPM pool, internal route, optional Cloudflare DNS, NPM
proxy host, and certificate. HTML/PHP sites do not create a database.

### Website source

| Control | Function |
| --- | --- |
| **WordPress** | Enables fresh WordPress installation or archive-plus-database import. |
| **Static / PHP** | Creates or imports HTML, CSS, JavaScript, assets, and optional PHP without MySQL. |
| **New website** | Downloads WordPress or creates a minimal HTML/PHP starter according to website type. |
| **Import website** | Accepts a ZIP/TAR website archive, flattens a single wrapper directory, and requires SQL only for WordPress. |
| **Domain** | Primary hostname used by nginx, NPM, WordPress, and optional DNS. |
| **Website directory** | Overrides the directory name below the shared websites root; defaults to the domain. |
| **Website title** | Sets the title during a fresh WordPress installation. |
| **PHP pool profile** | Selects the initial Low, Medium, or High PHP-FPM resource profile. |
| **WordPress admin email/username/password** | Creates the initial administrator. An empty password is generated and returned once in the result. |
| **Notes** | Stores an operator-facing site note. |

### Provisioning options

| Control | Function |
| --- | --- |
| **Add www alias** | Adds `www.domain` for an apex domain and configures the canonical route. |
| **Enable Redis object cache** | Installs and configures Redis Cache during provisioning. |
| **Enable FastCGI page cache** | Enables anonymous HTML caching for the new route. |
| **Enable PHP OPcache** | Enables PHP bytecode caching for the site. |
| **Enable daily backup** | Includes the new site in scheduled backup runs. |
| **Enable daily image optimization** | Includes the new site in the optional incremental WebP schedule. |
| **Create NPM proxy host** | Creates the public NPM edge host targeting `hosting-nginx`. |
| **Request SSL** | Requests or attaches a Let's Encrypt certificate after the NPM host exists. DNS must already resolve to the server. |
| **Enable comments by default** | Leaves WordPress comments enabled; the default is off. |
| **Keep bundled WordPress plugins/themes** | Retains packages shipped with WordPress. Both are off by default so unwanted defaults are removed. |

### DNS and packages

| Control | Function |
| --- | --- |
| **Create or update website DNS** | Creates or replaces the host record through Cloudflare. |
| **Server IPv4** | Selects a saved server address or accepts a manually entered IPv4 address. |
| **Add DNS preset records** | Applies the selected reusable DNS record set after host DNS is created. |
| **Installation packages** | Selects uploaded plugin and theme ZIP files for fresh installation. No package is selected by default. The first selected theme is activated. |
| **Create website** | Validates the request and queues durable provisioning; follow progress in Jobs. |
| **Upload plugins / Upload themes** | Adds ZIP packages to the persistent panel library for future installations. |

The fresh WordPress installer removes the default `Hello world!` post. Failed
provisioning reports the completed step in **Jobs** and preserves failed import
staging for up to 24 hours. Successful WordPress jobs show **Reveal credentials**;
the encrypted credentials expire after 24 hours and disappear immediately after
the first reveal. Provisioning does not silently overwrite an existing non-empty
website or configured domain.

When local provisioning succeeds but optional DNS, NPM, or SSL work fails, the
job is marked **partially succeeded**. The job retains the exact warning and the
notification system treats it as warning severity instead of reporting a false
success. Generated credentials remain available through the same one-time
reveal action because the local WordPress/database operation completed.

## DNS & SSL

This workspace combines Cloudflare zone records with Nginx Proxy Manager edge
state for one selected website.

| Control | Function |
| --- | --- |
| **Website selector** | Chooses the primary website whose zone and NPM host are managed. |
| **Cloudflare Refresh** | Loads DNS records from the longest matching active Cloudflare zone. |
| **DNS preset / Add preset records** | Applies all records from a saved preset to the selected zone. |
| **Add record** | Creates A, AAAA, CNAME, TXT, MX, or CAA records with TTL, priority, and supported proxy settings. |
| **Edit** | Loads an existing record into the form and changes **Add record** to an update action. |
| **Delete** | Deletes the selected Cloudflare record after confirmation. |
| **NPM Refresh** | Loads the proxy host, target, enabled state, and certificate relationship. |
| **Create or link host** | Creates the NPM proxy host when absent or links an existing matching host to panel state. |
| **Issue SSL** | Requests a Let's Encrypt certificate and enables HTTPS for the host. |
| **Renew SSL** | Requests renewal for the currently attached certificate. |

Issuing SSL requires public DNS to resolve to the server and inbound ports 80
and 443 to reach NPM. Cloudflare proxying can remain enabled when the account and
challenge path support certificate issuance.

## Security

Only Cloudflare rules created by Hosting Control are displayed or modified.
Unrelated user-managed WAF rules remain outside panel ownership.

| Control | Function |
| --- | --- |
| **Refresh** | Resolves the website's active zone and loads panel-managed WAF/rate-limit rules. |
| **Sensitive probes / Apply** | Blocks requests for exposed configuration, repository, and common exploit paths. |
| **XML-RPC challenge / Apply** | Adds a managed challenge for WordPress XML-RPC requests without disabling XML-RPC at nginx. |
| **Login rate limit / Apply** | Blocks an IP after five `/wp-login.php` requests in 10 seconds for 10 seconds; compatible with Cloudflare Free limits. |
| **Enabled** | Enables or disables an existing panel-managed rule. |
| **Remove** | Deletes that managed rule from Cloudflare. |

Security uses a separate Cloudflare token so DNS and WAF permissions can be
scoped independently. Rules apply at zone scope even though a website is used
to select the zone.

## Backups

WordPress backup sets contain `website.tar.gz`, `database.sql.gz`, and
`manifest.json`. HTML/PHP sets contain the website archive and manifest only;
restore performs the staged file swap without invoking MySQL. Application-data
sets contain an app-data archive and a consistent dump of all databases.

| Control | Function |
| --- | --- |
| **Back up enabled sites** | Immediately backs up sites whose per-site **Daily** checkbox is enabled. |
| **Back up all sites** | Immediately backs up every primary site regardless of its per-site checkbox. |
| **Back up app data** | Archives application data and creates a logical all-databases dump. |
| **Start time** | Sets the daily schedule in the server's displayed timezone. |
| **Backup sets to keep** | Sets retention per website and for application-data sets. Older complete sets are pruned. |
| **Enable website backups** | Globally pauses or resumes scheduled/manual website backup actions without clearing per-site choices. |
| **Back up app data every day** | Enables the daily application-data backup. |
| **Save schedule** | Persists schedule, retention, and global switches. |
| **Refresh** | Reloads active job progress and stored backup sets. |
| **Backup-set selector** | Chooses application data or one website's history. |
| **Restore** | Restores a complete website file/database set after creating a safety backup. |
| **Delete** | Deletes one complete stored set. It never removes only the archive or only the database dump. |

Only one backup job runs at a time. Application-data restore is intentionally a
maintenance procedure performed with the stack stopped; it is not exposed as a
one-click panel action.

## Delete

Deletion is ownership-aware and requires typing the selected domain. Always
click **Refresh preview** immediately before removal so shared or externally
changed resources are detected.

| Control | Function |
| --- | --- |
| **Refresh preview** | Rebuilds the resource plan from live runtime, WordPress, NPM, Cloudflare, panel, and backup state. |
| **Create final safety backup** | Creates a new complete set before any selected resource is removed. |
| **Internal host routes and aliases** | Removes primary and canonical internal nginx routes owned by the site. |
| **PHP-FPM pool** | Removes the dedicated pool only when it is not shared. |
| **Website files** | Permanently removes the owned document root. |
| **MySQL database and website user** | Drops the database and matching site user only when ownership checks pass. |
| **NPM proxy host** | Removes the matching proxy host when it is not shared. |
| **NPM certificate** | Removes the certificate only when no other host references it. |
| **Cloudflare A, AAAA, and CNAME records** | Removes exact web-host records; mail and unrelated records are retained. |
| **Panel cache and backup settings** | Clears saved per-site cache and scheduling state. |
| **Stored website backups** | Deletes all stored backup sets for the site. This is off by default. |
| **Delete selected resources** | Queues a durable deletion job after the confirmation domain exactly matches. Follow progress and results in **Jobs**. |

Uncheck any resource that must be retained. Shared resources are disabled or
skipped rather than force-deleted.

## Runtime

Runtime is the low-level configuration editor. Prefer Sites and Provision for
normal work; use Runtime for diagnosis and manual correction.

| Control | Function |
| --- | --- |
| **Validate** | Runs nginx and PHP-FPM configuration validation without reloading services. |
| **Reload nginx** | Validates and gracefully reloads internal nginx. |
| **Reload PHP-FPM** | Validates and gracefully reloads PHP-FPM. |
| **Clear OPcache** | Resets shared PHP OPcache so scripts are recompiled. |
| **Save pools** | Validates and writes the complete PHP-FPM pool model. |
| **Save routes** | Validates and writes internal host, alias, document-root, pool, and canonical-route mappings. |
| **Refresh logs** | Reloads the bounded PHP-FPM log tail. |

Manual route or pool changes can affect every site. Export or back up the
current configuration before large edits.

## Settings

### Integration settings

| Control | Function |
| --- | --- |
| **NPM API URL, account email, password, ACME email** | Configures NPM API access and the email used for certificate requests. Empty secret fields retain saved values. |
| **Test NPM** | Authenticates and verifies the NPM API without saving unrelated changes. |
| **Cloudflare API token / Account ID** | Configures DNS access. Account-owned `cfat_` tokens require the 32-character account ID. |
| **Test Cloudflare** | Verifies token identity and accessible zones. |
| **Cloudflare Security token** | Stores the separately scoped WAF/rulesets credential. |
| **Test Cloudflare Security** | Verifies security permissions independently of DNS. |
| **Clear saved ...** | Deletes the corresponding encrypted secret when settings are saved. |
| **MySQL container / Database-user prefix** | Configures where new databases are created and how database/user names begin. |
| **Test MySQL** | Verifies container access using the database container's existing root environment. |
| **Save integration settings** | Encrypts and persists integration configuration. |

### Performance settings

| Section | Managed values |
| --- | --- |
| **PHP and OPcache** | Per-request memory, execution timeout, OPcache memory, interned strings, maximum files, and timestamp validation. |
| **FastCGI page cache** | Keys-zone memory, disk maximum, inactivity expiry, response validity, upstream timeout, and cache locking. |
| **Redis and MySQL** | Redis memory/eviction policy and MySQL buffer pool, connection limit, and redo capacity. |
| **Apply performance settings** | Validates ranges, writes managed configuration, and reloads the affected services. |

### Notifications

| Control | Function |
| --- | --- |
| **Installation name / Server name** | Identifies the deployment and physical host in every alert. |
| **Public panel URL** | Adds a direct operator link; leave it empty when the panel has no safe public route. |
| **Telegram token / Chat IDs** | Sends alerts through a BotFather-created bot only to the listed chats. Empty token fields retain the encrypted value. |
| **SMTP settings / Recipients** | Sends plain-text alerts through an external STARTTLS or implicit-TLS relay. |
| **Job severities** | Selects failures, partial/cancelled outcomes, and optional successes. Successes are off by default. |
| **Send ... test** | Sends one test using saved settings without changing enablement or severity filters. |
| **Save notification settings** | Validates and encrypts notification configuration. |

Tests use the last saved credentials. Save changed values before sending a test.
Provider errors are bounded and do not expose tokens or passwords in the Jobs
workspace.

### DNS tools

| Control | Function |
| --- | --- |
| **Add record to preset** | Adds the current A, AAAA, CNAME, TXT, MX, or CAA template to the draft set. `{domain}` is replaced when applied. |
| **Save preset set** | Saves the named multi-record preset for Provision and DNS & SSL. |
| **Edit / Delete** | Changes or removes a saved preset set. |
| **Save IP list** | Stores reusable server IPv4 choices. |
| **Replace matching A records** | Replaces one exact IPv4 value across accessible active zones while preserving each record's TTL and proxy state. Requires confirmation. |

Changing global performance values affects the entire shared stack. Apply one
group of intentional changes at a time and verify Stats and service logs.

## Account

Account changes the panel's native login; it does not change NPM, File Browser,
WordPress, MySQL, or Cloudflare credentials.

| Control | Function |
| --- | --- |
| **Email** | Replaces the panel sign-in email after current-password verification. |
| **Current password** | Authorizes any account change. |
| **New password / Confirm new password** | Changes the panel password. Leave both empty to keep the existing password. |
| **Save account** | Validates the current password, updates credentials, and keeps authentication scoped to the panel. |
| **Sign out** | Invalidates the current panel session. |

The Account screenshot is intentionally omitted from the public repository so
browser-autofilled credentials cannot be captured accidentally.

## Related documentation

- [Configuration](CONFIGURATION.md)
- [Operations](OPERATIONS.md)
- [API routes](API.md)
- [Architecture](ARCHITECTURE.md)
