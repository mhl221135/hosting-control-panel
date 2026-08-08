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

The remote WordPress enforcement enrollment endpoints use the standard billing
admin session and CSRF rules. All enrollment bodies are guarded (reject
non-object bodies, prototype-pollution keys, unknown fields, and CR/LF/NUL
control characters; validate UUIDs, domains, code shape, and integer expiry
bounds; bound request size), and errors never echo submitted codes or
credentials.

| Method/path | Purpose |
|---|---|
| `POST /api/enrollment/codes` | Admin only. Create a one-time, short-lived enrollment code (1-168 hours) for an eligible remote/shared-hosting service, targeted at its canonical primary domain. Returns the plaintext code exactly once. |
| `GET /api/enrollment/codes?service_id=...` | Admin only. Bounded code history with pending/used/revoked/expired status; never returns plaintext codes or hashes. |
| `POST /api/enrollment/codes/revoke` | Admin only. Idempotently revoke a pending enrollment code. |
| `POST /api/enrollment/installations/revoke` | Admin only. Idempotently revoke an installation credential. |
| `GET /api/enrollment/installations?service_id=...` | Admin only. Bounded list of installations for a service; never contains hashes or credentials. |
| `POST /api/enrollment/exchange` | Public one-time route. Exchange a code for a new installation ID and a per-installation credential, which is revealed exactly once. Atomic; rejects replay, expiry, revocation, archived/ineligible services, and canonical-domain mismatch. |

Eligible services are non-archived records with `location` `shared`; local
payment-page enforcement and notification-only records are ineligible. Only
hashes of enrollment codes and installation credentials are stored.

### Remote entitlement and signing-key lifecycle

`POST /remote/v1/entitlement` authenticates a remote WordPress installation
by installation ID (header `X-Installation-Id`) and its one-time credential
(header `Authorization: Bearer <credential>`). The credential is hashed before
comparison and authentication errors are generic. The response contains only
`ok`, the deterministic allowlisted entitlement payload, and its Ed25519
signature. The renewal URL uses an opaque public reference rather than the
internal service ID. Rate limiting is per authenticated installation (60
requests/minute) and per IP; invalid callers cannot consume another
installation's quota by spoofing its ID.

`GET /remote/v1/keys` returns only the active and still-overlapping previous
public keys; private keys and encrypted material are never exposed.

Authenticated billing administrators manage signing keys:

| Method/path | Purpose |
|---|---|
| `GET /api/enrollment/signing/status` | Return active and previous keys, configured state |
| `POST /api/enrollment/signing/initialize` | Confirm `INITIALIZE`; create the first active Ed25519 signing key; requires `BILLING_SETTINGS_KEY` environment variable |
| `POST /api/enrollment/signing/rotate` | Confirm `ROTATE` and supply the last observed `expected_key_id`; atomically replace that active key and retain its public key for a bounded overlap window. A stale expected key returns `409`. |
| `POST /api/enrollment/signing/retire` | Confirm `RETIRE` (or `EMERGENCY` to bypass the overlap window); remove a previously rotated key |
| `GET /api/enrollment/installations/:id/entitlement-preview` | Administrator preview of a single installation's entitlement payload without signing or a usable credential |

Signing private keys are stored encrypted (AES-256-GCM, same key hierarchy as
other billing secrets); plaintext private keys are never logged, audited,
exported, or returned. Exactly one active key is maintained by a database
constraint. Rotation erases the previous encrypted private key immediately;
only its public key remains during overlap.

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
`POST /internal/v1/billing-entitlements/refresh` uses the same internal bearer
boundary and accepts only a bounded WooCommerce delivery ID. The panel ignores
provider payload data, fetches the signed entitlement feed itself, and
reconciles only when enforcement is already enabled.

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

Ambiguous WooCommerce callbacks persist a review flag and bounded display-safe
reason on the payment. `POST /api/payments/:id/review/resolve` requires a
3-500-character resolution note and acknowledges that flag with an audit/event
record. It never changes payment status or renewal dates. A paid callback with
an amount or currency mismatch moves a still-pending payment to `review`, which
also disables its public checkout links.

`GET /api/public-reference/status` returns only active/previous key
fingerprints and overlap timestamps. `POST /api/public-reference/rotate`
requires `ROTATE`, a reason, and a 24-2160 hour overlap. A second rotation is
rejected while an old key remains active. Raw HMAC keys are never returned.

`GET /api/payment-options` returns the disabled-by-default schedule and a
read-only due-order preview. `PUT /api/payment-options/settings` updates the
daily schedule. `POST /api/payment-options/run` requires `CREATE`, creates only
missing eligible options, and refreshes an exact expired selection only after
WooCommerce confirms cancellation of its previous order. Ambiguous overlapping
expired selections are reported as blocked for operator review. A run creates
at most 10 orders and reports the remaining eligible rows as deferred.

WooCommerce settings accept an optional `support_url` HTTPS destination and
3-80 character `support_label`. A valid renewal reference with no active option
shows that bounded public contact action. Invalid references retain the same
generic unavailable response and never disclose the support destination.

The observer routes are read-only. None of these routes exposes the shared
token or has website mutation or enforcement capability; the retry route can
only repeat the bounded billing registration.

Local enforcement is a separate hosting-side boundary:

| Method/path | Purpose |
|---|---|
| `GET /api/billing/enforcement` | Read global settings, last apply status, bounded transition history, and the current fail-open plan |
| `PUT /api/billing/enforcement/settings` | Save the global switch and explicit pilot-domain allowlist |
| `POST /api/billing/enforcement/reconcile` | Require `RECONCILE`, validate nginx, and atomically apply the current plan |
| `POST /api/billing/enforcement/disable` | Require `DISABLE`, turn off enforcement, and immediately clear the managed map |

The switch defaults off and the allowlist defaults empty. A plan can redirect
only a local unambiguous service whose fresh signed state is `suspended`, policy
is `payment_page`, and signed renewal URL is valid HTTPS. Invalid, stale, or
unavailable state produces an empty map. Audit entries contain service/domain
transition metadata but never payment URLs or customer details. Enabling
enforcement requires scheduled observation, and scheduled observation cannot be
disabled until enforcement is off.

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
| `POST /api/backups/restore` | Restore a validated site set; optionally create/reuse billing |
| `DELETE /api/backups/...` | delete a complete backup set |
| `GET,PUT /api/backups/offsite` | sanitized Restic configuration, recent jobs, and snapshots |
| `POST /api/backups/offsite/initialize` | initialize a new encrypted repository after confirmation |
| `POST /api/backups/offsite/sync` | queue encrypted replication and retention |
| `POST /api/backups/offsite/check` | queue repository integrity verification |
| `POST /api/backups/offsite/restore-test` | queue an isolated representative restore test |

Backup, restore, maintenance, and image-optimization POST routes return `202`
with a public job record. Use the job API to follow completion rather than
holding the originating HTTP request open.

Website restore accepts boolean `register_billing` and
`billing_grant_free_period` fields. Registration runs only after the validated
file/database restore succeeds, uses persisted billing defaults and the
restore job ID as its idempotency key, and never rolls back a successful
restore when billing is unavailable. A billing failure becomes a retryable job
warning.

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
| `GET /api/pool-presets` | reusable Low, Medium, and High PHP-FPM defaults, including each profile's validated `estimated_memory_mb` planning value |
| `PUT /api/pool-presets` | validate and atomically save PHP-FPM defaults without changing existing pools |
| `POST /api/pool-presets/preview` | validate proposed defaults and list matching existing pools that would change without writing configuration |
| `POST /api/pool-presets/apply/preview` | validate proposed defaults and list affected pools plus preserved custom/drifted pools without writing configuration |
| `POST /api/pool-presets/apply` | require `APPLY` and `selected_pools`; back up presets/pools/sites.map, validate with `php-fpm -t`, reload through the controlled action, verify every pool port, and roll back automatically on failure |
| `GET /api/pool-presets/audit` | read-only bounded recent PHP-FPM profile save/preview/apply audit events (optional `limit`, capped at 250) |
| `GET /api/status` | readiness plus `capacity.guardrails`: a bounded CPU/memory capacity summary (worker slots, slots per CPU, estimated worker memory, PHP ceiling, host RAM, healthy/warning/critical status, custom-pool fallback count) |
| `POST /api/validate` | nginx and PHP-FPM configuration tests |
| `POST /api/actions/:action` | allowlisted reload/OPcache actions; PHP-FPM reload verifies every configured pool port |

`estimated_memory_mb` is validated server-side as an integer from 32 to 4096 MB;
NaN, fractional, negative, oversized, unknown, and malformed values are
rejected. Existing `pool-presets.json` files without the field read with the
documented per-tier default (low 96 MB, medium 128 MB, high 192 MB). The value
is planning metadata only and is never rendered into PHP-FPM pool
configuration; changing only it never makes pools drift, triggers a reload, or
appears in the apply preview. The capacity summary statuses are stable:
memory compares estimated and ceiling totals against host RAM (warning at
>50% estimated or >75% ceiling, critical at >75% estimated or >90% ceiling),
and CPU compares worker slots per CPU (warning at >4, critical at >8). Missing
or zero host CPU/RAM, an unreadable pool source, or malformed/excess pool data
is reported safely as `unknown` instead of as a healthy empty system.

Successful profile saves and successful pool applications are recorded as
mutating audit events. Failed applies after execution begins are recorded with
their rollback outcome (`not-required`, `succeeded`, or `failed`). Read-only
previews are recorded as non-mutating events. Audit entries contain the
timestamp, operator, operation, selected/affected pool names, profile names,
changed field names, result/rollback status, and a bounded redacted error
summary. They never contain passwords, tokens, environment values, website
contents, full configuration files, customer data, or request headers. The
audit store is bounded (250 events by default), written atomically, and
tolerates missing, empty, or corrupted state. `GET /api/pool-presets/audit`
requires only a valid session (no CSRF token for a read-only GET).

### Runtime mutation transaction and port verification

Every operation that creates or changes a PHP-FPM pool/listen port runs through
the shared `RuntimeConfigTransaction` (`lib/runtime-transaction.js`), which
serializes map/pool writes across the panel and one-shot CLI containers through
the shared `app-data/ui-manager/runtime-config.lock` directory, captures
`sites.map`/`pools.conf` before mutating,
rejects stale previewed state and invalid models, writes both files atomically
with timestamped backups, validates nginx + PHP-FPM, reloads PHP-FPM and nginx,
verifies every configured pool port with bounded retries, and rolls back to the
prior validated/reloaded/verified files on failure. Commit responses are sent
only after every required port accepts a TCP connection. Failures preserve the
original error and attach a bounded, distinct rollback outcome
(`not-required`, `succeeded`, or `failed`); `rolled back` is never reported
unless restored files were validated, reloaded, and verified. Partial writes
(when one file is written but the next fails) restore both captured files
before reporting. Request bodies for the pool/host/preset routes are parsed
through a guarded helper (`readJsonBody`) that rejects non-object bodies,
prototype-pollution keys (`__proto__`/`constructor`/`prototype`), excessively
deep, oversized or
unknown structures, and returns bounded errors; field-level validation
(`lib/runtime-validation.js`) rejects malformed hosts, unsafe document roots,
non-integer/out-of-range ports, invalid tiers/process managers, and unsupported
fields while preserving backward compatibility for valid existing state.

Mutation matrix (operation, files changed, port allocation, validation,
transaction, reload, verification, rollback, audit):

| Operation | Files changed | Changes/allocates port | Validation | Transaction | Reload | Port verify | Rollback | Audit |
|---|---|---|---|---|---|---|---|---|
| `POST /api/pools/upsert` | pools.conf, sites.map | yes | shared | runtimeTxn | nginx+php | yes | verified | runtime-config |
| `POST /api/pools/bulk-upsert` | pools.conf, sites.map | yes | shared | runtimeTxn | nginx+php | yes | verified | runtime-config |
| `DELETE /api/pools/:name` | pools.conf, sites.map | no | shared | runtimeTxn | nginx+php | yes | verified | runtime-config |
| `POST /api/hosts/bulk-upsert` | sites.map | no | shared | runtimeTxn | nginx+php | yes | verified | runtime-config |
| `POST /api/hosts/upsert`, `/api/sites/upsert` | sites.map (+pools.conf) | yes | shared | runtimeTxn | nginx+php | yes | verified | runtime-config |
| `DELETE /api/hosts/:host`, `/api/sites/:host` | sites.map (+pools.conf) | no | shared | runtimeTxn | nginx+php | yes | verified | runtime-config |
| Fresh WordPress/Generic-PHP/OpenCart provisioning | sites.map, pools.conf | yes (gap-aware) | shared | runtimeTxn | nginx+php | yes | verified + post-failure rollback | runtime-config |
| Provisioning import | sites.map, pools.conf | yes (gap-aware) | shared | runtimeTxn | nginx+php | yes | verified | runtime-config |
| Portable import (MigrationManager/CLI) | sites.map, pools.conf | yes (gap-aware) | shared | runtimeTxn | nginx+php | yes | verified | runtime-config |
| OPcache change (`POST /api/site-state`) | pools.conf | no | shared | runtimeTxn | nginx+php | yes | verified | runtime-config |
| Site removal (`POST /api/site-removal`) | sites.map, pools.conf | no (may delete pool) | model | runtimeTxn | nginx+php | yes | verified | runtime-config |
| Static-route reclassification/recovery | sites.map, pools.conf, default.conf, site-state | yes (gap-aware) | model | offline CLI via `--apply`; shared `activateStaticMigration` | nginx+php | yes | verified | none (offline) |
| `POST /api/pool-presets/apply` | pools.conf, sites.map, pool-presets.json | changes pools | preset | preset's own verification, serialized under the same lock | php | yes | verified | php-fpm preset audit |

### Runtime-configuration audit

`GET /api/runtime-config/audit` (authenticated read-only, optional `limit`
capped at 250 and optional `category` filter) returns bounded recent runtime
mutation events for pool, host, provisioning, import, opcache, removal, and
reclassification activity. Entries store the timestamp, operator, category,
mutating flag, result, verification, rollback outcome, bounded counts, and a
bounded scope of internal identifiers — not domains, secrets, submitted
payloads, or full configuration contents. Errors are bounded and redacted
(bearer/token/password/URL-credential/domain patterns). Storage is
`app-data/ui-manager/runtime-config-audit.json`, atomic mode 0600, versioned
history bounded at 250, tolerant of missing/corrupt files, and entries are
re-sanitized on read. This stream is distinct from the PHP-FPM preset audit
(`/api/pool-presets/audit`), which records only profile save/preview/apply; the
runtime-configuration audit covers all other runtime mutations.

Invalid requests are rejected before reload: ports outside 1-65535, duplicate
listen ports, malformed/non-integer ports, a site upstream that disagrees with
its pool port, PHP-enabled routes referencing a missing pool, and duplicate or
inconsistent pool sections. Port allocation uses a gap-aware allocator that
ignores malformed existing ports, fills gaps rather than `max+1`, and refuses
to run when the range is exhausted or invalid.

### Non-runtime settings mutation inventory

Every settings `PUT`/`POST` JSON mutation is parsed through a guarded body
reader (`readJsonBody`) plus `guardSettingsBody` (`lib/runtime-validation.js`),
which requires a plain object, rejects prototype-pollution keys
(`__proto__`/`constructor`/`prototype`), rejects excessive depth, size, and
array counts, rejects unknown top-level and declared nested fields, and rejects
CR/LF/NUL and other C0 control characters recursively. Numeric bounds, enums, URLs,
hostnames, ports, and schedules are validated by each owning module. Secret
fields are stored only inside the encrypted settings mechanism and are never
returned, logged, audited, or persisted in plaintext; omitted or masked secret
fields preserve the current secret, and empty input never erases credentials
unless an explicit clear flag is sent. Persistence is atomic (temp-file +
rename, mode 0600) and fail-closed; the performance endpoint additionally
restores the previous generated PHP/nginx/Redis/MySQL state on any validation,
reload, or application failure.

| Endpoint | Accepted fields | Secret fields | Validation module | Persistent file | Atomic / rollback |
|---|---|---|---|---|---|
| `PUT /api/settings/performance` | `php`, `opcache`, `fastcgi`, `redis`, `mysql` (nested numeric/enums) | none | `lib/performance-settings.js` | `performance-settings.json` | atomic + snapshot/restore rollback of generated files |
| `PUT /api/backups/settings` | `schedule_time`, `retention`, `site_backups_enabled`, `app_data_enabled` | none | `lib/backup-manager.js` | `backup-settings.json` | atomic |
| `PUT /api/backups/offsite` | `enabled`, `endpoint`, `bucket`, `prefix`, `region`, `access_key_id`, `secret_access_key`, `repository_password`, their explicit `clear_*` flags, `schedule_time`, `retention`, `upload_limit_kib`, `download_limit_kib`, `verify_percent`, `restore_test_enabled`, `restore_test_day`, `restore_test_time`, `restore_test_max_gib` | `access_key_id`, `secret_access_key`, `repository_password` (encrypted) | `lib/offsite-backup-manager.js` | `offsite-backup-settings.json` | atomic |
| `PUT /api/settings/notifications` | installation, telegram, SMTP, severity, and per-channel override fields | `telegramBotToken`, `smtpPassword` (encrypted) | `lib/notification-settings.js` | `notification-settings.json` | atomic |
| `PUT /api/settings/integrations` | `npmApiUrl`, `npmIdentity`, `acmeEmail`, `mysqlContainer`, `mysqlSitePrefix`, plus secret/clear fields | `npmSecret`, `cloudflareToken`, `cloudflareSecurityToken`, `ipinfoToken` (encrypted) | `lib/integration-settings.js` | `integration-settings.json` | atomic |
| `PUT /api/billing/provisioning-settings` | `enabled`, `free_months`, `renewal_months`, `hosting_price`, `domain_renewal_months`, `currency`, `grace_days`, `timezone` | none | `lib/billing-provisioning.js` | `billing-provisioning-settings.json` | atomic |
| `PUT /api/billing/observer/settings` | `enabled`, `intervalMinutes`, `maxSnapshotAgeSeconds` | none | `lib/billing-entitlement-observer.js` | `billing-observer-settings.json` | atomic |
| `PUT /api/billing/enforcement/settings` | `enabled`, `pilotDomains` | none | `lib/billing-enforcement.js` | `billing-enforcement-settings.json` | atomic |
| `PUT /api/health/settings` | `enabled`, `intervalMinutes`, `diskWarningPercent`, `diskCriticalPercent`, `certificateWarningDays`, `certificateCriticalDays`, `opcacheWarningPercent`, `publicCheckTimeoutSeconds`, `publicHosts`, `requiredContainers` | none | `lib/health-settings.js` | `health-settings.json` | atomic |
| `PUT /api/cloudflare/automation` | `provisioning_defaults_enabled`, `provisioning_presets`, `protected_addresses` | none | `lib/cloudflare-automation-manager.js` | `cloudflare-automation-settings.json` | atomic |
| `PUT /api/cloudflare/ip-addresses` | `addresses[]` (valid IPv4s, ≤50) | none | `lib/ip-addresses.js` | `cloudflare-ip-addresses.json` | atomic |
| `POST /api/dns-presets` | `id`, `label`, `records`/DNS fields | none | `lib/dns-presets.js` | `dns-presets.json` | atomic |

### Manager-backed mutation inventory

These mutations are served by dedicated managers and are validated through the
same guarded body parser (`readJsonBody` + `guardSettingsBody`) with explicit
schemas: only listed properties are accepted, prototype-pollution keys and
recursive C0 control characters are rejected, and bounds/enums/schedules are
checked by each manager. Capability rules are enforced server-side (Redis and
image optimization only for WordPress; PHP controls rejected for static HTML),
and `domain` must resolve to a configured primary host — `www` aliases are not
separately manageable and are rejected. Omitted optional fields preserve the
existing value.

| Endpoint | Accepted fields | Restriction / bounds | Manager | Persistent file | Persistence / rollback |
|---|---|---|---|---|---|
| `PUT /api/site-state` | `domain`, `fastcgi_cache`, `redis`, `opcache`, `backup_enabled`, `image_optimization_enabled`, `maintenance_enabled`, `notes` | Redis/image-opt require WordPress; opcache/fastcgi per adapter; notes ≤2000 | `lib/site-state.js` | `site-state.json` + generated `cache.map` (+`pools.conf`/`sites.map` for opcache) | atomic site-state transaction (single lock, full restore) |
| `POST /api/site-state/purge` | `domain` | primary host only | `lib/site-state.js` | `site-state.json` + `cache.map` | atomic site-state transaction |
| `PUT /api/sites/images/settings` | `enabled`, `schedule_time` (24h `HH:MM`) | schedule regex | `lib/image-optimization-manager.js` | `image-optimization-settings.json` | atomic |
| `PUT /api/maintenance/settings` | `enabled`, `weekday` (0-6), `schedule_time`, `operations[]`, `revision_retention` (1-100) | weekday/schedule/operations/revision bounds | `lib/maintenance-manager.js` | `maintenance-settings.json` | atomic |
| `PUT /api/maintenance/updates/pins` | `domain`, `site`, `core`, `plugins[]`, `themes[]`, `plugin_package_ids[]`, `theme_package_ids[]`, `note` | WordPress primary only; package ids resolved; note ≤300 | `lib/wordpress-update-manager.js` | `wordpress-update-pins.json` | atomic; fail-closed on corrupt state; active-update conflict blocked |

Site-state transaction details (`lib/site-state-transaction.js`): runs under
the shared runtime transaction lock (single boundary, no nesting/deadlock),
snapshots `site-state.json`, `cache.map`, `sites.map`, and `pools.conf`, builds
and validates the proposed outputs, writes every affected file atomically,
validates nginx + PHP-FPM, reloads PHP-FPM and nginx (nginx only for cache-map
changes), verifies pool ports, and applies the WordPress Redis integration
before reporting success. If execution has begun and any step fails, it
restores all snapshots and compensates any attempted Redis change; only
services whose activation was attempted are reloaded and re-verified. Failures
before the first write report `not-required` without disrupting services. The
transaction attaches a bounded redacted rollback error and reports `rollback` as
`not-required`, `succeeded`, or `failed` — `rolled back` is never reported
unless every restoration step succeeds.

## Adding Or Changing Routes

1. Validate and normalize input at the boundary.
2. Put reusable business logic in `lib/`, not browser JavaScript.
3. Preserve the authentication and CSRF contract.
4. Use a specific HTTP status and a non-secret error response.
5. Add a Node test and a browser workflow check when the UI changes.
6. Update this route index when public behavior changes.
