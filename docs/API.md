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

Backup, restore, maintenance, and image-optimization POST routes return `202`
with a public job record. Use the job API to follow completion rather than
holding the originating HTTP request open.

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
| `POST /api/settings/test` | test NPM, Cloudflare, Security, or MySQL |

Notification settings retain global failure/warning/success defaults and allow
Telegram and SMTP to either inherit them or store independent channel filters.
Omitted channel fields preserve inherited behavior for older API clients.

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
| `GET,PUT /api/site-state` | Redis/OPcache/FastCGI/backup/image/maintenance state |
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

### WordPress and media

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
