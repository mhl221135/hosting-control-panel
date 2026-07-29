# Panel API

The panel serves JSON APIs and static frontend assets from one Node.js process
on port 8687. `ui-manager/app/server.js` is the authoritative route definition.

## Authentication Contract

- `POST /api/auth/login` accepts email/password and sets an HTTP-only cookie.
- `GET /api/auth/status` returns authentication state and the CSRF value.
- `POST /api/auth/logout` requires the session and `X-CSRF-Token`.
- `PUT /api/auth/account` changes email/password using the current password.
- Every other `/api/*` route requires an authenticated session.
- `POST`, `PUT`, `PATCH`, and `DELETE` requests require `X-CSRF-Token`.

Errors use HTTP status codes and this shape:

```json
{ "ok": false, "message": "Human-readable error", "details": "Optional detail" }
```

Do not expose secrets in public settings responses or error details.

## Billing API

Billing uses a separate process, account, session cookie, CSRF token, database,
and route namespace on port `8787`. Its browser endpoints include authentication,
status, service inventory, audit, settings, transactional CSV preview/apply and
export, WooCommerce settings/test, payment-link creation and history, plus
backup create/test/restore. They do not accept a hosting-panel session.

Service inventory routes are:

| Method/path | Purpose |
|---|---|
| `GET /api/services` | Search/filter active, archived, or all service records |
| `POST /api/services` | Create one validated service with a stable ID |
| `PUT /api/services/:id` | Update a service using its `updated_at` precondition |
| `POST /api/services/:id/archive` | Archive or restore while preserving history |

Create/update values are validated server-side. A duplicate primary domain or
stale `updated_at` value returns `409`; no service hard-delete route exists.

`GET /internal/v1/entitlements` requires
`Authorization: Bearer <BILLING_API_TOKEN>`. It returns current renewal state
and an HMAC-SHA256 signature. `/health` is unauthenticated and reports schema
health, but returns `503` during backup or restore maintenance. The complete
contract and recovery workflow are in `BILLING.md`.

`POST /internal/v1/services` requires the same bearer token plus a bounded
`Idempotency-Key`. It is a create-only provisioning adapter: duplicate primary
domains return the existing stable service and it never exposes billing
inventory administration. A supplied `trial_anchor` fixes free-period
calculation to the original provisioning date so a delayed retry cannot extend
the trial.

`POST /webhooks/woocommerce` is public and requires a valid WooCommerce
HMAC-SHA256 signature, unique delivery ID, and an allowed order topic.
`GET /pay/:token` resolves only an unexpired pending token hash and redirects to
its fixed WooCommerce order-pay URL. Neither endpoint accepts arbitrary redirect
targets or hosting-panel credentials.

`GET /renew/:opaque-reference` is a no-store, rate-limited public summary of
already-created renewal options. It contains no client/contact data and cannot
create orders. `GET /renew/:opaque-reference/checkout/:payment-id` redirects
only when both opaque identifiers resolve to the same active pending payment.
Invalid and expired lookups use a generic unavailable page.

Billing's authenticated reminder routes read/update the disabled-by-default
schedule, return due preview/history, and run the outbox manually.
`POST /internal/v1/billing-reminders` on `hosting-ui` is not a browser API. It
requires `BILLING_API_TOKEN`, accepts only the bounded reminder schema, and
constructs its own notification event before enqueueing Telegram/SMTP delivery.

The authenticated hosting-panel billing integration routes are:

| Method/path | Purpose |
|---|---|
| `GET /api/billing/observer` | Sanitized observer settings, freshness, matches, and drift |
| `PUT /api/billing/observer/settings` | Enable/disable polling and set bounded interval/freshness |
| `POST /api/billing/observer/refresh` | Fetch and verify one signed snapshot immediately |
| `GET /api/billing/provisioning-settings` | Read non-secret registration defaults and connection state |
| `PUT /api/billing/provisioning-settings` | Validate and persist registration defaults |
| `POST /api/jobs/:id/retry-billing` | Queue a billing-only retry for a completed provision whose billing step warned |

Billing inventory also exposes
`POST /api/services/:id/actions/{exempt,resume,suspend}`. It requires a
3-500-character `reason` and the current `updated_at` value. The action is
audited and concurrency-safe. `resume` clears the override and returns to
date-calculated state; `suspend` changes billing state only and has no website
mutation authority.

Pending renewal orders expose `POST /api/payments/:id/cancel` with a required
3-500-character reason. Creating a payment link may include
`replace_payment_id` plus `replacement_reason`; the selected pending order must
still belong to the same service and renewal selection. WooCommerce must
confirm `cancelled` before the local token is invalidated or a replacement is
created.

`GET /api/public-reference/status` returns only active/previous key
fingerprints and overlap timestamps. `POST /api/public-reference/rotate`
requires `ROTATE`, a reason, and a 24-2160 hour overlap. A second rotation is
rejected while an old key remains active. Raw HMAC keys are never returned.

The observer routes are read-only. None of these routes exposes the shared
token or has website mutation or enforcement capability; the retry route can
only repeat the bounded billing registration.

## Route Groups

### Status and statistics

| Method/path | Purpose |
|---|---|
| `GET /api/status` | config/action/integration readiness |
| `GET /api/stats/runtime` | host, container, PHP, OPcache, Redis, FastCGI snapshot |
| `GET /api/stats/site?domain=` | disk and NPM traffic for one primary site |
| `POST /api/stats/ipinfo/lookup` | enrich one current public traffic address on demand |
| `DELETE /api/stats/ipinfo/cache` | clear normalized cached IPinfo results |

Statistics are on-demand and cached. `refresh=1` bypasses the short runtime
cache; avoid adding permanent polling.

### Backups

| Method/path | Purpose |
|---|---|
| `GET,PUT /api/backups/settings` | global schedule, pause, retention |
| `GET /api/backups` | backup history/status |
| `POST /api/backups/site` | backup one site |
| `POST /api/backups/sites` | start enabled-site or all-site batch backup |
| `POST /api/backups/app-data` | archive app data and dump all databases |
| `POST /api/backups/restore` | restore a validated site set |
| `DELETE /api/backups/...` | delete a complete backup set |
| `GET,PUT /api/backups/offsite` | sanitized Restic configuration, recent jobs, and snapshots |
| `POST /api/backups/offsite/initialize` | initialize a new encrypted repository after confirmation |
| `POST /api/backups/offsite/sync` | queue encrypted replication and retention |
| `POST /api/backups/offsite/check` | queue repository integrity verification |
| `POST /api/backups/offsite/restore-test` | queue an isolated representative restore test |

Backup, restore, maintenance, and image-optimization POST routes return `202`
with a public job record. Use the job API to follow completion rather than
holding the originating HTTP request open.

Off-site secret fields are write-only. Blank secret fields preserve the stored
encrypted value. Jobs contain no repository credentials or encryption material.

### Portable transfers

| Method/path | Purpose |
|---|---|
| `GET /api/transfers/export/preview?domain=` | preview selected primary sites, aliases, type, root, and database |
| `POST /api/transfers/export` | queue a durable portable export job |
| `GET /api/transfers/exports` | list completed export bundles and artifact metadata |
| `GET /api/transfers/exports/:id?file=` | download one bounded regular artifact |
| `GET /api/transfers/import/sources` | list staged directories with a manifest or lightweight plan |
| `POST /api/transfers/import/upload` | stream one ordered portable-bundle chunk |
| `GET /api/transfers/import/upload/status` | return the committed resumable bundle offset |
| `POST /api/transfers/import/upload/finalize` | queue durable validation and staging |
| `POST /api/transfers/import/preview` | resolve and fingerprint a staged import without mutation |
| `POST /api/transfers/import` | revalidate and queue a typed-confirmed durable import |
| `POST /api/transfers/import/cleanup` | queue confined cleanup after exact-source confirmation |

The export request accepts a non-empty `domains` array. Aliases resolve to their
primary site. Export jobs share the backup storage lock, continue after
individual site failures, and can be cancelled only between complete site
bundles. Downloads are confined to completed export directories and default to
a 512 MB per-file limit.

Import preview accepts `source`, `wan_ip`, `update_dns`, `proxied`,
`create_npm_host`, and `issue_ssl`. Apply additionally requires the unchanged
`preview_id` and `confirm: "IMPORT"`. Sources are confined below `/srv/imports`.
Blocking file, database, or configured-domain conflicts return `409`; existing
exact-host DNS records and NPM hosts are visible in preview before their
create-or-update actions. Import jobs are non-cancellable and non-retryable.
Cleanup requires `confirm` to equal `source`, accepts only a listed direct
manifest-bearing directory, and shares the `storage:imports` job conflict.

Bundle upload requires a UUID `upload_id`, original `filename`, `offset`, and
`total_size`; the raw body is limited to a 32 MiB chunk and the browser uses 16
MiB. Status returns the committed byte count. Finalize queues non-retryable
`sites.import-upload-stage`, which rejects unsafe entries and symlinks, validates
the sole control manifest, and requires checksum coverage for every referenced
portable-export artifact.

### Background jobs

| Method/path | Purpose |
|---|---|
| `GET /api/jobs?status=&type=&limit=` | list newest durable jobs with optional filters |
| `GET /api/jobs/:id` | read one public job record |
| `POST /api/jobs/:id/cancel` | cancel queued work or request cancellation at the next safe boundary |
| `POST /api/jobs/:id/retry` | enqueue a linked retry of a finished retryable job |

Public records include lifecycle status, operator, trigger, targets, progress,
current step, bounded results/errors, timestamps, conflicts, retry linkage, and
the active job blocking queued work. Internal handler payloads and idempotency
keys are not returned. Job payloads containing password, token, secret, key,
authorization, cookie, SQL, or dump fields are rejected before persistence.

### Integrations and performance

| Method/path | Purpose |
|---|---|
| `GET,PUT /api/settings/integrations` | public view/update encrypted settings |
| `GET,PUT /api/settings/performance` | validate and apply resource settings |
| `GET,PUT /api/settings/notifications` | read/update encrypted delivery settings and read-only Telegram command status |
| `POST /api/settings/notifications/test` | send one Telegram or SMTP test through saved settings |
| `POST /api/settings/test` | test NPM, Cloudflare, Security, or MySQL |

Notification settings retain global failure/warning/success defaults and allow
Telegram and SMTP to either inherit them or store independent channel filters.
Omitted channel fields preserve inherited behavior for older API clients. The
optional Telegram command fields enable `/status` and `/site domain` only with
separate numeric chat and sender-user allowlists. The independent mutation flag
adds confirmed `/backup domain` and FastCGI-only `/purge domain`; their
two-minute one-use challenges are never returned through the HTTP API.

### NPM and certificates

| Method/path | Purpose |
|---|---|
| `GET /api/npm/hosts` | list proxy hosts |
| `GET /api/npm/certificates` | list certificates |
| `POST /api/npm/hosts/ensure` | create/link a host synchronously, or queue certificate issuance with `issue_ssl` |
| `POST /api/npm/certificates/renew` | queue renewal of a certificate revalidated against the selected host |

Certificate issuance and renewal return `202` with a durable job. Their exact
failures flow through normal job notifications. These external mutations are
serialized per NPM integration and website, cannot be cancelled after starting,
and require a fresh operator action after failure instead of blind retry.

### Cloudflare

| Method/path | Purpose |
|---|---|
| `GET,POST /api/cloudflare/records` | list/create DNS records |
| `PUT,DELETE /api/cloudflare/records/:id` | update/delete one record |
| `GET /api/cloudflare/security` | panel-owned rules for a site/zone |
| `POST /api/cloudflare/security/presets` | apply a known preset |
| `PATCH,DELETE /api/cloudflare/security/...` | toggle/delete owned rule |
| `GET,POST,DELETE /api/dns-presets...` | manage/apply record templates |
| `GET,PUT /api/cloudflare/ip-addresses` | reusable IPv4 values |
| `POST /api/cloudflare/replace-a-records` | exact-match bulk A migration |
| `GET,PUT /api/cloudflare/automation` | presets, defaults, protected addresses, batch and incident history |
| `POST /api/cloudflare/automation/preview` | immutable provider-state bulk dry run |
| `POST /api/cloudflare/automation/apply` | queue a confirmed sequential bulk job |
| `POST /api/cloudflare/automation/rollback` | queue reversal of one recorded panel-owned batch |
| `POST /api/cloudflare/incidents/preview` | validate and preview one current-traffic action |
| `POST /api/cloudflare/incidents/apply` | queue a confirmed temporary mitigation or cache purge |
| `POST /api/cloudflare/incidents/remove` | queue early removal of a panel-owned mitigation |

Bulk apply requires the current 64-character preview ID and `confirm: "APPLY"`.
Rollback requires `confirm: "ROLLBACK"`. Incident apply accepts only the
unchanged server preview and revalidates its traffic sample before queueing.

### Sites, pools, and caches

| Method/path | Purpose |
|---|---|
| `GET /api/sites` | parsed primary sites and aliases |
| `POST /api/hosts/upsert` | create/update one runtime host |
| `POST /api/hosts/bulk-upsert` | update multiple runtime hosts |
| `DELETE /api/hosts/:host` | remove host and unused pool |
| `GET /api/pools` | pool definitions and host use |
| `POST /api/pools/upsert` | create/update one pool |
| `POST /api/pools/bulk-upsert` | update multiple pools |
| `DELETE /api/pools/:name` | remove an unused pool |
| `GET,PUT /api/site-state` | capability-validated Redis/OPcache/FastCGI/backup/image/maintenance state |
| `POST /api/site-state/purge` | increment FastCGI version |

### Website removal

| Method/path | Purpose |
|---|---|
| `GET /api/site-removal?domain=` | recalculate resource ownership and safety |
| `POST /api/site-removal` | queue deletion of selected safe resources after typed confirmation; returns `202` and a job |

Removal accepts separate booleans for final backup, runtime routes, pool, files,
database/user, NPM host, NPM certificate, Cloudflare web DNS, panel state, and
stored backups. POST ignores browser assumptions and rebuilds the ownership
plan before mutation. Shared or unverified resources return `409`.
Deletion jobs conflict with other server-heavy and same-site work. They can be
cancelled before the final backup or before destructive removal starts, but are
not retryable after failure; refresh the preview and submit a new operation.

### Website provisioning, WordPress, and media

| Method/path | Purpose |
|---|---|
| `POST /api/provision` | validate and queue a website provisioning job |
| `POST /api/provision/import-upload` | stream one staged website archive or database dump |
| `POST /api/provision/credentials/:jobId/reveal` | reveal and delete generated credentials once |
| `GET /api/wordpress-packages` | list stored plugin/theme packages |
| `POST /api/wordpress-packages/:kind` | upload a ZIP package |
| `DELETE /api/wordpress-packages/:kind/:id` | remove a package |
| `POST /api/sites/images/optimize` | optimize one site's uploads |
| `GET /api/sites/images/status` | persisted bulk-job status |
| `POST /api/sites/images/optimize-all` | start sequential optimization |
| `GET /api/maintenance/status` | persisted maintenance status and weekly settings |
| `PUT /api/maintenance/settings` | update weekly schedule and operations |
| `POST /api/maintenance/revisions/preview` | count revisions that exceed per-post retention for selected sites without mutation |
| `POST /api/maintenance/run` | start maintenance for selected WordPress sites |
| `POST /api/maintenance/inventory` | queue read-only core/plugin/theme inventory for selected WordPress sites |
| `PUT /api/maintenance/updates/pins` | replace persistent whole-site/core/package update exclusions for one site |
| `POST /api/maintenance/updates/preview` | refresh and preview one explicit controlled update selection |
| `POST /api/maintenance/updates/apply` | queue a confirmed backup-protected one-site update |

Update apply requires the unchanged server preview and `confirm: "UPDATE"`.
The job is non-cancellable, conflicts with server-heavy and same-site work, and
automatically invokes complete backup restore after update or health failure.
Pins are enforced during every preview and again at job execution. Pin changes
are rejected while the selected website has a queued or running update.

Maintenance revision retention accepts an integer from 1 through 100 and
defaults to five newest revisions per post. Preview runs sequentially and
isolates failures by website. Deletion occurs only when `revisions` is included
in a manual or scheduled maintenance job.

`POST /api/provision/import-upload` requires `upload_id`, `kind` (`website` or
`database`), and `filename` query parameters. Its body is the raw file. A later
`POST /api/provision` with `source_mode: "import"` and the same
`import_upload_id` validates the request and returns a durable job. The job
normalizes and consumes staged files, and removes staging only after success.
Generated credentials are encrypted outside job state, expire after 24 hours,
and are deleted by the first successful reveal request.

`site_type` accepts `wordpress`, `opencart`, `generic-php`, or `static`.
OpenCart accepts import mode only and requires both staged archive and database
objects. It validates and rewrites storefront/admin configuration without
executing uploaded PHP; automatic OpenCart updates are unsupported.

Provisioning accepts optional `apply_security_preset` and `security_preset`
fields. Allowed presets are `suspicious-probes`, `xmlrpc-challenge`, and
`login-rate-limit`; the latter two require a WordPress site. Cloudflare failure
is returned as a partial job warning after local creation rather than rollback.

### Runtime administration

| Method/path | Purpose |
|---|---|
| `GET /api/logs` | recent PHP-FPM container logs |
| `POST /api/validate` | nginx and PHP-FPM configuration tests |
| `POST /api/actions/:action` | allowlisted reload/OPcache actions |

## Adding Or Changing Routes

1. Validate and normalize input at the boundary.
2. Put reusable business logic in `lib/`, not browser JavaScript.
3. Preserve the authentication and CSRF contract.
4. Use a specific HTTP status and a non-secret error response.
5. Add a Node test and a browser workflow check when the UI changes.
6. Update this route index when public behavior changes.
